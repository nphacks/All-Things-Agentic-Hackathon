"""Firestore service for project CRUD operations.

Project document structure:
    projects/{project_id}:
        name: str
        created_at: timestamp
        updated_at: timestamp
        clips: [{clip_id, filename, gcs_url, duration, thumbnail_url}]
        jobs: [job_id_1, job_id_2, ...]
        status: "active" | "archived"
"""

import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from google.cloud import firestore

from app.services.firestore import get_db


PROJECTS_COLLECTION = "projects"


def create_project(name: str) -> dict[str, Any]:
    """Create a new project document.

    Args:
        name: Display name for the project.

    Returns:
        The full project document including the generated project_id.
    """
    db = get_db()
    project_id = str(uuid.uuid4())
    now = datetime.now(timezone.utc)

    doc = {
        "name": name,
        "created_at": now,
        "updated_at": now,
        "clips": [],
        "jobs": [],
        "status": "active",
    }

    db.collection(PROJECTS_COLLECTION).document(project_id).set(doc)
    doc["project_id"] = project_id
    return doc


def get_project(project_id: str) -> Optional[dict[str, Any]]:
    """Retrieve a full project document.

    Args:
        project_id: Project identifier.

    Returns:
        Project document dict with project_id included, or None if not found.
    """
    db = get_db()
    doc = db.collection(PROJECTS_COLLECTION).document(project_id).get()
    if not doc.exists:
        return None
    data = doc.to_dict()
    data["project_id"] = project_id
    return data


def list_projects() -> list[dict[str, Any]]:
    """List all active projects ordered by most recently updated.

    Returns:
        List of project documents (each includes project_id).
    """
    db = get_db()
    # Fetch all projects and filter/sort in code to avoid needing a composite index.
    docs = db.collection(PROJECTS_COLLECTION).stream()

    projects = []
    for doc in docs:
        data = doc.to_dict()
        if data.get("status") != "active":
            continue
        data["project_id"] = doc.id
        projects.append(data)

    # Sort by updated_at descending
    projects.sort(key=lambda p: p.get("updated_at", datetime.min.replace(tzinfo=timezone.utc)), reverse=True)

    return projects


def update_project(project_id: str, data: dict[str, Any]) -> Optional[dict[str, Any]]:
    """Update a project document with partial data.

    Args:
        project_id: Project identifier.
        data: Fields to update (e.g., name, status).

    Returns:
        Updated project document, or None if project not found.
    """
    db = get_db()
    doc_ref = db.collection(PROJECTS_COLLECTION).document(project_id)

    # Verify project exists
    if not doc_ref.get().exists:
        return None

    data["updated_at"] = datetime.now(timezone.utc)
    doc_ref.update(data)

    return get_project(project_id)


def add_clip_to_project(
    project_id: str,
    clip_id: str,
    filename: str,
    gcs_url: str,
    duration: Optional[float] = None,
    thumbnail_url: Optional[str] = None,
) -> Optional[dict[str, Any]]:
    """Add a clip entry to a project's clips array.

    Args:
        project_id: Project identifier.
        clip_id: Unique clip identifier.
        filename: Original filename.
        gcs_url: Public GCS URL for playback.
        duration: Clip duration in seconds (may be filled later after analysis).
        thumbnail_url: Optional thumbnail URL.

    Returns:
        Updated project document, or None if project not found.
    """
    db = get_db()
    doc_ref = db.collection(PROJECTS_COLLECTION).document(project_id)

    if not doc_ref.get().exists:
        return None

    clip_entry = {
        "clip_id": clip_id,
        "filename": filename,
        "gcs_url": gcs_url,
        "duration": duration,
        "thumbnail_url": thumbnail_url,
    }

    doc_ref.update({
        "clips": firestore.ArrayUnion([clip_entry]),
        "updated_at": datetime.now(timezone.utc),
    })

    return get_project(project_id)


def remove_clip_from_project(project_id: str, clip_id: str) -> Optional[dict[str, Any]]:
    """Remove a clip from a project's clips array.

    Args:
        project_id: Project identifier.
        clip_id: The clip_id to remove.

    Returns:
        Updated project document, or None if project not found.
    """
    db = get_db()
    doc_ref = db.collection(PROJECTS_COLLECTION).document(project_id)

    doc = doc_ref.get()
    if not doc.exists:
        return None

    data = doc.to_dict()
    updated_clips = [c for c in data.get("clips", []) if c.get("clip_id") != clip_id]

    doc_ref.update({
        "clips": updated_clips,
        "updated_at": datetime.now(timezone.utc),
    })

    return get_project(project_id)


def add_job_to_project(project_id: str, job_id: str) -> Optional[dict[str, Any]]:
    """Link a job to a project.

    Args:
        project_id: Project identifier.
        job_id: Job identifier to add.

    Returns:
        Updated project document, or None if project not found.
    """
    db = get_db()
    doc_ref = db.collection(PROJECTS_COLLECTION).document(project_id)

    if not doc_ref.get().exists:
        return None

    doc_ref.update({
        "jobs": firestore.ArrayUnion([job_id]),
        "updated_at": datetime.now(timezone.utc),
    })

    return get_project(project_id)
