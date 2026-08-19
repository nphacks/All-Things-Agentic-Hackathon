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
        f"clip_analyses.{clip_id}": analysis,
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
        "proposals": proposals,
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
