"""Music re-selection and search endpoints.

Allows users to:
1. Refine music via agent feedback (Gemini picks a new track based on user feedback)
2. Search Jamendo directly (no AI, fast passthrough)
"""

import json
from typing import Any, Optional

from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from app.agent.tools import _search_jamendo, _build_volume_keyframes, _get_genai_client
from app.services.firestore import get_job, store_music_data


router = APIRouter(prefix="/projects/{project_id}/music", tags=["music"])


# --- Request/Response Models ---

class MusicRefineRequest(BaseModel):
    proposal_index: int
    feedback: str
    current_music: Optional[dict[str, Any]] = None
    job_id: Optional[str] = None


class MusicSearchRequest(BaseModel):
    query: str


class MusicTrackResult(BaseModel):
    id: str
    name: str
    artist_name: str
    duration: int
    audio: str
    tags: list[str]


class MusicRefineResponse(BaseModel):
    status: str
    music: dict[str, Any]


# --- Refine Prompt ---

REFINE_MUSIC_PROMPT = """You are selecting a NEW background music track based on user feedback.

## Current Track (being replaced)
{current_track_info}

## User Feedback
"{feedback}"

## Available Tracks from Jamendo
{tracks_json}

## Your Task
Select the track that BEST addresses the user's feedback. The user wants something DIFFERENT from the current track.

Consider:
1. What the user specifically asked for
2. How the new track differs from the old one in the direction requested
3. Duration should work for a {timeline_duration}s timeline

Return ONLY valid JSON:
{{
  "selected_track_index": <0-based index into the tracks array>,
  "track_start": <seconds into the track to begin playback>,
  "reason": "Why this track addresses the user's feedback"
}}"""


# --- Endpoints ---

@router.post("/refine", response_model=MusicRefineResponse)
def refine_music(project_id: str, request: MusicRefineRequest):
    """Refine music selection using agent feedback.

    Takes the user's feedback about the current music and searches Jamendo
    for a better match. Uses Gemini to select the best track from results.
    Updates the proposal's music in Firestore.
    """
    if not request.feedback or not request.feedback.strip():
        raise HTTPException(status_code=400, detail="Feedback cannot be empty")

    # Get speech chunks from the proposal for auto-ducking
    speech_chunks = []
    timeline_duration = 30.0  # default
    job_data = None

    if request.job_id:
        job_data = get_job(request.job_id)
        if job_data:
            proposals = job_data.get("proposals", [])
            if request.proposal_index < len(proposals):
                proposal = proposals[request.proposal_index]
                speech_chunks = proposal.get("speech", [])
                timeline_duration = proposal.get("total_duration", 30.0)

    # Derive search keywords from feedback
    # Use the feedback itself as search terms (user says "more upbeat" -> search "upbeat")
    search_keywords = request.feedback.strip()

    # Search Jamendo
    tracks = _search_jamendo(search_keywords, timeline_duration)

    if not tracks:
        # Fallback: try broader search with first word
        first_word = search_keywords.split()[0] if search_keywords else "music"
        tracks = _search_jamendo(first_word, timeline_duration)

    if not tracks:
        raise HTTPException(
            status_code=404,
            detail="No tracks found matching the feedback criteria. Try different keywords.",
        )

    # Build current track info for context
    current_track_info = "No current track"
    if request.current_music:
        cm = request.current_music
        current_track_info = f"Title: {cm.get('title', 'Unknown')}, Artist: {cm.get('artist', 'Unknown')}, Tags: {cm.get('tags', [])}"

    # Ask Gemini to select the best track
    prompt = REFINE_MUSIC_PROMPT.format(
        current_track_info=current_track_info,
        feedback=request.feedback,
        tracks_json=json.dumps(tracks, indent=2),
        timeline_duration=timeline_duration,
    )

    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"AI selection failed: {e}")

    # Parse selection
    raw_text = response.text.strip()
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        selection = json.loads(raw_text)
    except json.JSONDecodeError:
        raise HTTPException(status_code=502, detail="Failed to parse AI music selection response")

    # Get selected track
    track_index = selection.get("selected_track_index", 0)
    if track_index < 0 or track_index >= len(tracks):
        track_index = 0

    selected_track = tracks[track_index]
    track_start = max(0.0, float(selection.get("track_start", 0)))
    reason = selection.get("reason", "Selected based on user feedback")

    # Calculate placement
    track_duration = int(selected_track.get("duration", 0))
    available_from_start = track_duration - track_start
    end_time = min(timeline_duration, available_from_start)

    # Build volume keyframes with auto-ducking
    volume_keyframes = _build_volume_keyframes(
        timeline_duration=end_time,
        speech_chunks=speech_chunks,
    )

    # Build music result
    music_data = {
        "track_id": str(selected_track.get("id", "")),
        "title": selected_track.get("name", ""),
        "artist": selected_track.get("artist_name", ""),
        "url": selected_track.get("audiodownload", "") or selected_track.get("audio", ""),
        "preview_url": selected_track.get("audio", ""),
        "duration": track_duration,
        "tags": selected_track.get("tags", []),
        "placement": {
            "start_time": 0.0,
            "end_time": round(end_time, 2),
            "track_start": round(track_start, 2),
        },
        "volume_keyframes": volume_keyframes,
        "reason": reason,
    }

    # Store in Firestore if we have a job
    if request.job_id and job_data:
        store_music_data(request.job_id, request.proposal_index, music_data)

    return MusicRefineResponse(status="success", music=music_data)


@router.post("/search")
def search_music(project_id: str, request: MusicSearchRequest) -> list[MusicTrackResult]:
    """Search Jamendo directly for music tracks.

    Direct API passthrough -- no AI/agent involvement.
    Fast response for when users want to browse and pick their own track.
    """
    if not request.query or not request.query.strip():
        raise HTTPException(status_code=400, detail="Search query cannot be empty")

    tracks = _search_jamendo(request.query.strip(), duration=20.0)

    return [
        MusicTrackResult(
            id=str(t.get("id", "")),
            name=t.get("name", ""),
            artist_name=t.get("artist_name", ""),
            duration=int(t.get("duration", 0)),
            audio=t.get("audio", ""),
            tags=t.get("tags", []),
        )
        for t in tracks
    ]
