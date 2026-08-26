"""Firestore service for job state management."""

import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from google.cloud import firestore

from app.config import settings


def _get_client() -> firestore.Client:
    """Get a Firestore client, resolving credentials path relative to backend dir."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        # Resolve relative to backend/ directory (where .env and service-account.json live)
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return firestore.Client(
        project=settings.google_cloud_project,
        database=settings.firestore_database,
    )


# Module-level client (lazy init)
_client: Optional[firestore.Client] = None


def get_db() -> firestore.Client:
    """Get or create the Firestore client singleton."""
    global _client
    if _client is None:
        _client = _get_client()
    return _client


JOBS_COLLECTION = "jobs"


def sanitize_for_firestore(value: Any) -> Any:
    """Recursively strip/convert values that Firestore cannot serialize.

    Firestore (and JSON) cannot store raw bytes or arbitrary objects. This
    walks dicts/lists and converts bytes to a decoded string (or drops them),
    leaving primitives untouched. Prevents "Object of type bytes is not JSON
    serializable" errors that would otherwise crash the whole job.
    """
    if isinstance(value, bytes):
        # Represent bytes as a short placeholder rather than storing raw data
        return f"<bytes:{len(value)}>"
    if isinstance(value, dict):
        clean = {}
        for k, v in value.items():
            # Keys must be strings for Firestore/JSON
            if isinstance(k, bytes):
                key = k.decode("utf-8", errors="replace")
            elif not isinstance(k, str):
                key = str(k)
            else:
                key = k
            clean[key] = sanitize_for_firestore(v)
        return clean
    if isinstance(value, (list, tuple)):
        return [sanitize_for_firestore(v) for v in value]
    if isinstance(value, (str, int, float, bool)) or value is None:
        return value
    # Datetime and Firestore sentinel types pass through
    if isinstance(value, datetime):
        return value
    # Fallback: stringify anything else (Part objects, etc.)
    try:
        return str(value)
    except Exception:
        return None


def create_job(job_id: str, job_data: dict[str, Any]) -> dict[str, Any]:
    """Create a new job document with status 'pending'.

    Args:
        job_id: Unique job identifier.
        job_data: Dict with keys: brief, settings, clips.

    Returns:
        The full job document as stored.
    """
    db = get_db()
    now = datetime.now(timezone.utc)

    doc = {
        "status": "pending",
        "brief": job_data.get("brief", ""),
        "settings": job_data.get("settings", {}),
        "clips": job_data.get("clips", []),
        "created_at": now,
        "updated_at": now,
        "clip_analyses": {},
        "proposals": [],
        "error": None,
    }

    db.collection(JOBS_COLLECTION).document(job_id).set(doc)
    doc["job_id"] = job_id
    return doc


def update_job_status(job_id: str, status: str, error: Optional[str] = None, progress: Optional[str] = None) -> None:
    """Update job status and timestamp.

    Args:
        job_id: Job identifier.
        status: One of: pending, analyzing, generating, completed, failed.
        error: Optional error message (used when status is 'failed').
        progress: Optional progress message for frontend display.
    """
    db = get_db()
    update: dict[str, Any] = {
        "status": status,
        "updated_at": datetime.now(timezone.utc),
    }
    if error is not None:
        update["error"] = error
    if progress is not None:
        update["progress"] = progress

    db.collection(JOBS_COLLECTION).document(job_id).update(update)


def store_clip_analysis(job_id: str, clip_id: str, analysis: dict[str, Any]) -> None:
    """Store analysis results for a single clip.

    Args:
        job_id: Job identifier.
        clip_id: Clip identifier.
        analysis: Structured analysis dict from Gemini.
    """
    db = get_db()
    db.collection(JOBS_COLLECTION).document(job_id).update({
        f"clip_analyses.{clip_id}": sanitize_for_firestore(analysis),
        "updated_at": datetime.now(timezone.utc),
    })


def store_clip_audio_analysis(job_id: str, clip_id: str, audio_analysis: dict[str, Any]) -> None:
    """Store audio analysis results for a single clip.

    Stored under clip_analyses.{clip_id}.audio in Firestore.

    Args:
        job_id: Job identifier.
        clip_id: Clip identifier.
        audio_analysis: Structured audio analysis dict from Gemini.
    """
    db = get_db()
    db.collection(JOBS_COLLECTION).document(job_id).update({
        f"clip_analyses.{clip_id}.audio": sanitize_for_firestore(audio_analysis),
        "updated_at": datetime.now(timezone.utc),
    })


def store_clip_waveform(job_id: str, clip_id: str, waveform: list[float]) -> None:
    """Store waveform amplitude data for a single clip.

    Stored under clip_analyses.{clip_id}.waveform in Firestore.

    Args:
        job_id: Job identifier.
        clip_id: Clip identifier.
        waveform: Array of floats (0.0-1.0) representing peak amplitudes.
    """
    db = get_db()
    db.collection(JOBS_COLLECTION).document(job_id).update({
        f"clip_analyses.{clip_id}.waveform": waveform,
        "updated_at": datetime.now(timezone.utc),
    })


def store_speech_data(job_id: str, proposal_index: int, speech_chunks: list[dict]) -> None:
    """Store rendered speech data for a proposal.

    Stored under proposals[proposal_index].speech in Firestore.

    Args:
        job_id: Job identifier.
        proposal_index: Index of the proposal in the proposals array.
        speech_chunks: Array of rendered speech chunk dicts (with gcs_url, audio_duration).
    """
    db = get_db()
    doc_ref = db.collection(JOBS_COLLECTION).document(job_id)
    doc = doc_ref.get()
    if not doc.exists:
        return

    data = doc.to_dict()
    proposals = data.get("proposals", [])
    if proposal_index < len(proposals):
        proposals[proposal_index]["speech"] = sanitize_for_firestore(speech_chunks)
        doc_ref.update({
            "proposals": proposals,
            "updated_at": datetime.now(timezone.utc),
        })


def store_proposals(job_id: str, proposals: list[dict[str, Any]]) -> None:
    """Store generated proposals for a job.

    Args:
        job_id: Job identifier.
        proposals: List of proposal dicts.
    """
    db = get_db()
    db.collection(JOBS_COLLECTION).document(job_id).update({
        "proposals": sanitize_for_firestore(proposals),
        "updated_at": datetime.now(timezone.utc),
    })


def get_job(job_id: str) -> Optional[dict[str, Any]]:
    """Retrieve full job document.

    Args:
        job_id: Job identifier.

    Returns:
        Job document dict with job_id included, or None if not found.
    """
    db = get_db()
    doc = db.collection(JOBS_COLLECTION).document(job_id).get()
    if not doc.exists:
        return None
    data = doc.to_dict()
    data["job_id"] = job_id
    return data


def store_music_data(job_id: str, proposal_index: int, music: dict[str, Any]) -> None:
    """Store background music selection data for a proposal.

    Stored under proposals[proposal_index].music in Firestore.

    Args:
        job_id: Job identifier.
        proposal_index: Index of the proposal in the proposals array.
        music: Music selection dict (track_id, title, artist, url, placement, volume_keyframes, etc.).
    """
    db = get_db()
    doc_ref = db.collection(JOBS_COLLECTION).document(job_id)
    doc = doc_ref.get()
    if not doc.exists:
        return

    data = doc.to_dict()
    proposals = data.get("proposals", [])
    if proposal_index < len(proposals):
        proposals[proposal_index]["music"] = sanitize_for_firestore(music)
        doc_ref.update({
            "proposals": proposals,
            "updated_at": datetime.now(timezone.utc),
        })


def store_text_overlays(job_id: str, proposal_index: int, text_overlays: list[dict]) -> None:
    """Store text overlays (titles, captions, lower thirds, end cards) for a proposal.

    Stored under proposals[proposal_index].text_overlays in Firestore.

    Args:
        job_id: Job identifier.
        proposal_index: Index of the proposal in the proposals array.
        text_overlays: Array of text overlay dicts (id, type, text, start_time, end_time, etc.).
    """
    db = get_db()
    doc_ref = db.collection(JOBS_COLLECTION).document(job_id)
    doc = doc_ref.get()
    if not doc.exists:
        return

    data = doc.to_dict()
    proposals = data.get("proposals", [])
    if proposal_index < len(proposals):
        proposals[proposal_index]["text_overlays"] = sanitize_for_firestore(text_overlays)
        doc_ref.update({
            "proposals": proposals,
            "updated_at": datetime.now(timezone.utc),
        })


def store_edit_log(job_id: str, edit_log: list[dict[str, Any]]) -> None:
    """Store the AI edit log for a job.

    The edit log captures agent decisions during job execution.
    Stored under jobs/{job_id}.edit_log in Firestore.

    Args:
        job_id: Job identifier.
        edit_log: List of log entry dicts (action, summary, timestamp, etc.).
    """
    db = get_db()
    db.collection(JOBS_COLLECTION).document(job_id).update({
        "edit_log": sanitize_for_firestore(edit_log),
        "updated_at": datetime.now(timezone.utc),
    })
