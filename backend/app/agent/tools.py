"""ADK agent tools for video analysis and edit plan generation.

These are designed as ADK-compatible function tools:
- Clear, descriptive names and docstrings (LLM reads these)
- Type-annotated parameters with simple types
- Return dicts with status keys
- Handle errors gracefully (return error info, don't raise)
"""

import json
import os
from pathlib import Path

from google import genai
from google.genai.types import Part

from app.config import settings


# Maximum video file size we'll send to Gemini (200MB)
MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024


ANALYZE_CLIP_PROMPT = """Analyze this video clip for use in a video advertisement. Return ONLY valid JSON (no markdown, no code fences).

Use this exact schema:
{{
  "duration_seconds": <number>,
  "segments": [
    {{
      "start": <seconds>,
      "end": <seconds>,
      "description": "What happens visually in this segment",
      "mood": "Emotional tone (e.g., majestic, calm, energetic, warm)",
      "energy": "low|medium|high",
      "visual_quality": "low|medium|high",
      "usability": "How this segment could be used in an ad (e.g., strong opener, transition, product shot, filler)"
    }}
  ],
  "overall_mood": "Dominant mood of the entire clip",
  "best_moments": [
    {{"time": <seconds>, "why": "Why this moment stands out visually or emotionally"}}
  ],
  "has_text": <boolean>,
  "has_faces": <boolean>
}}

Rules:
- Segments must cover the full clip duration with no gaps
- end of one segment equals start of the next
- energy and visual_quality must be exactly: "low", "medium", or "high"
- best_moments should highlight 1-3 peak visual or emotional moments
- has_text: true if any text, signs, or writing is visible
- has_faces: true if any human faces are clearly visible
- Return ONLY valid JSON, nothing else

{additional_focus}"""


GENERATE_EDIT_PLAN_PROMPT = """You are an experienced video editor. You have analyzed a set of raw video clips and now need to assemble one timeline proposal for an advertisement.

## Creative Brief
{brief}

## Duration Constraints
- Minimum duration: {min_duration} seconds
- Maximum duration: {max_duration} seconds
The total timeline MUST fall within these constraints.

## Creative Direction
{variation_instruction}

## Available Clip Analyses
{clip_analyses_json}

## Your Task
Create ONE timeline proposal that satisfies the brief and creative direction. Think like an experienced editor:
- Consider pacing, narrative arc, visual flow, and emotional impact
- You may choose NOT to use clips that don't fit -- this is a real editorial decision
- Select the best segments from each clip (you don't have to use the full clip)
- Ensure smooth transitions between segments

Return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{{
  "label": "Short descriptive name for this edit approach",
  "reasoning": "2-3 sentences explaining your editorial choices",
  "total_duration": <number - total seconds of the assembled timeline>,
  "timeline": [
    {{
      "clip_id": "<file_path from the clip analysis>",
      "filename": "<filename portion of the file_path>",
      "start": <start second within the original clip>,
      "end": <end second within the original clip>,
      "position_in_timeline": <start position in the assembled timeline>,
      "transition": "cut"
    }}
  ],
  "clips_not_used": ["<file_path>", ...],
  "clips_not_used_reason": "Brief explanation of why these clips were excluded"
}}

Rules:
- IMPORTANT: Use the exact file_path from each clip analysis as the clip_id value
- timeline segments must be ordered by position_in_timeline
- position_in_timeline of first segment is 0
- Each segment's duration = end - start
- position_in_timeline of segment N = position_in_timeline of segment N-1 + duration of segment N-1
- total_duration must equal position_in_timeline of last segment + duration of last segment
- total_duration MUST be between {min_duration} and {max_duration} seconds
- transition is always "cut" for v1
- Return ONLY valid JSON"""


def _get_genai_client():
    """Get a google-genai client configured for Vertex AI."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        # Resolve relative to backend/ directory
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return genai.Client(
        vertexai=True,
        project=settings.google_cloud_project,
        location="us-central1",
    )


def analyze_clip(video_file_path: str, focus: str = "") -> dict:
    """Analyze a video clip to understand its content, mood, energy, and usable segments.

    Use this tool to understand what is in a video clip before making editing decisions.
    You can call this multiple times for the same clip with different focus areas if
    the initial analysis is missing information you need.

    Args:
        video_file_path: Absolute path to the video file on disk.
        focus: Optional additional analysis focus. Use this to ask for specific details
               that were missing from a previous analysis (e.g., "focus on the text and
               signage visible in the clip" or "look more closely at seconds 5-8 for
               transition opportunities"). Leave empty for standard analysis.

    Returns:
        dict: Analysis results with status, segments, mood, best_moments, and token usage.
              On error, returns status="error" with a message.
    """
    file_path = Path(video_file_path)

    # Validate file exists
    if not file_path.exists():
        return {
            "status": "error",
            "message": f"Video file not found: {video_file_path}",
        }

    # Validate file size
    file_size = file_path.stat().st_size
    if file_size > MAX_VIDEO_SIZE_BYTES:
        return {
            "status": "error",
            "message": f"Video file too large: {file_size / 1024 / 1024:.1f}MB. Max: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f}MB.",
        }

    # Determine mime type from extension
    ext = file_path.suffix.lower()
    mime_map = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
    mime_type = mime_map.get(ext, "video/mp4")

    # Read video bytes
    video_bytes = file_path.read_bytes()
    video_part = Part.from_bytes(data=video_bytes, mime_type=mime_type)

    # Build prompt with optional focus
    additional_focus = ""
    if focus:
        additional_focus = f"\nADDITIONAL FOCUS: {focus}\nPay special attention to this aspect in your analysis."

    prompt = ANALYZE_CLIP_PROMPT.format(additional_focus=additional_focus)

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[video_part, prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        analysis = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    analysis["status"] = "success"
    analysis["file_path"] = video_file_path
    analysis["input_tokens"] = input_tokens
    analysis["output_tokens"] = output_tokens

    return analysis


def generate_edit_plan(
    clip_analyses_json: str,
    brief: str,
    min_duration: int,
    max_duration: int,
    variation: str = "balanced",
) -> dict:
    """Generate one timeline proposal for a video advertisement.

    Takes all clip analyses, the creative brief, and a creative direction,
    then produces a structured timeline proposal with reasoning.

    Args:
        clip_analyses_json: JSON string of all clip analyses (array of analysis dicts).
        brief: The creative brief describing what the ad should achieve
               (e.g., "30-second energetic travel destination ad").
        min_duration: Minimum total duration in seconds for the timeline.
        max_duration: Maximum total duration in seconds for the timeline.
        variation: Creative direction for this proposal. Examples:
                   "fast pacing with rapid cuts",
                   "slow cinematic story arc",
                   "focus on mood and atmosphere",
                   "experimental and unconventional",
                   "balanced professional edit".

    Returns:
        dict: Proposal with status, label, reasoning, timeline, clips_not_used, and token usage.
              On error, returns status="error" with a message.
    """
    # Parse clip analyses
    try:
        clip_analyses = json.loads(clip_analyses_json)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Invalid clip_analyses_json: {e}",
        }

    # Build prompt
    prompt = GENERATE_EDIT_PLAN_PROMPT.format(
        brief=brief,
        min_duration=min_duration,
        max_duration=max_duration,
        variation_instruction=variation,
        clip_analyses_json=json.dumps(clip_analyses, indent=2),
    )

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        proposal = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    # Validate duration
    total_duration = proposal.get("total_duration", 0)
    if total_duration < min_duration or total_duration > max_duration:
        proposal["duration_warning"] = (
            f"Total duration {total_duration}s is outside constraints "
            f"({min_duration}-{max_duration}s)"
        )

    proposal["status"] = "success"
    proposal["input_tokens"] = input_tokens
    proposal["output_tokens"] = output_tokens

    return proposal
