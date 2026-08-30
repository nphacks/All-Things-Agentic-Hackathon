import asyncio
import uuid

from fastapi import APIRouter, HTTPException

from app.models.schemas import (
    JobCreateRequest,
    JobCreateResponse,
    JobSettings,
    JobStatusResponse,
    ProposalsResponse,
)
from app.services.agent_runner import run_agent_job
from app.services.clip_store import get_clips
from app.services.firestore import create_job, get_job, update_job_status
from app.services.projects import add_job_to_project, get_project

router = APIRouter(prefix="/jobs", tags=["jobs"])


def _file_path_from_gcs_url(gcs_url: str) -> str:
    """Rebuild the agent's gcs:// file_path from a public GCS URL.

    URL format: https://storage.googleapis.com/{bucket}/projects/{project_id}/clips/{filename}
    Target:     gcs://{project_id}/{filename}
    """
    marker = "/projects/"
    idx = gcs_url.find(marker)
    if idx == -1:
        return ""
    tail = gcs_url[idx + len(marker):]  # {project_id}/clips/{filename}
    parts = tail.split("/clips/", 1)
    if len(parts) != 2:
        return ""
    project_id, filename = parts[0], parts[1]
    return f"gcs://{project_id}/{filename}"


def _resolve_clips_from_project(project_id: str, clip_ids: list[str]) -> list[dict]:
    """Resolve clip metadata from the persistent project record in Firestore.

    Used when clips are not in the in-memory store (library clips, or after a
    server/instance restart). Returns clip dicts shaped like the in-memory store.
    """
    project = get_project(project_id)
    if not project:
        return []

    wanted = set(clip_ids)
    resolved: list[dict] = []
    for clip in project.get("clips", []):
        if clip.get("clip_id") not in wanted:
            continue
        gcs_url = clip.get("gcs_url", "")
        file_path = _file_path_from_gcs_url(gcs_url)
        if not file_path:
            continue
        resolved.append({
            "clip_id": clip.get("clip_id"),
            "filename": clip.get("filename", "clip.mp4"),
            "file_path": file_path,
            "gcs_url": gcs_url,
        })
    return resolved


@router.post("/create", response_model=JobCreateResponse)
async def create_job_endpoint(request: JobCreateRequest):
    """Create a new editing job and kick off the agent.

    Accepts a brief, clip IDs (from prior upload), and settings.
    Returns immediately with job_id and status 'pending'.
    The agent runs asynchronously in the background.
    """
    # Resolve clips from the in-memory store (fast path for just-uploaded clips)
    clips = get_clips(request.clip_ids)

    # Any clip_ids not in memory (e.g. library clips from a prior session, or
    # after a Cloud Run instance restart) are resolved from the project's
    # persistent Firestore record instead.
    found_ids = {c["clip_id"] for c in clips}
    missing = [cid for cid in request.clip_ids if cid not in found_ids]
    if missing and request.project_id:
        resolved = _resolve_clips_from_project(request.project_id, missing)
        clips.extend(resolved)
        found_ids = {c["clip_id"] for c in clips}
        missing = [cid for cid in request.clip_ids if cid not in found_ids]

    if not clips:
        raise HTTPException(
            status_code=400,
            detail="No valid clip_ids provided. Upload clips first via POST /clips/upload.",
        )

    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown clip_ids: {missing}. Upload clips first.",
        )

    # Use provided settings or defaults
    settings = request.settings or JobSettings()

    # Create job ID and Firestore record
    job_id = str(uuid.uuid4())
    job_data = {
        "brief": request.brief,
        "settings": settings.model_dump(),
        "clips": [
            {
                "clip_id": c["clip_id"],
                "filename": c["filename"],
                "file_path": c["file_path"],
                "gcs_url": c.get("gcs_url"),
            }
            for c in clips
        ],
    }
    create_job(job_id, job_data)

    # Get clip GCS URLs for agent (download from GCS for Gemini analysis)
    clip_info = [
        {"file_path": c["file_path"], "gcs_url": c.get("gcs_url"), "filename": c["filename"]}
        for c in clips
    ]

    # Kick off background task (real agent execution)
    asyncio.create_task(
        run_agent_job(job_id, clip_info, request.brief, settings.model_dump())
    )

    # Link job to project if project_id provided
    if request.project_id:
        add_job_to_project(request.project_id, job_id)

    return JobCreateResponse(job_id=job_id, status="pending")


@router.get("/{job_id}", response_model=JobStatusResponse)
async def get_job_status(job_id: str):
    """Get job status, progress, and results."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    # Convert timestamps to strings for JSON serialization
    created_at = job.get("created_at")
    updated_at = job.get("updated_at")

    return JobStatusResponse(
        job_id=job_id,
        status=job.get("status", "unknown"),
        progress=job.get("progress"),
        brief=job.get("brief"),
        error=job.get("error"),
        clips=job.get("clips", []),
        clip_analyses=job.get("clip_analyses", {}),
        proposals=job.get("proposals", []),
        edit_log=job.get("edit_log", []),
        created_at=str(created_at) if created_at else None,
        updated_at=str(updated_at) if updated_at else None,
    )


@router.get("/{job_id}/proposals", response_model=ProposalsResponse)
async def get_job_proposals(job_id: str):
    """Get just the proposals for a job (for frontend timeline rendering)."""
    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    return ProposalsResponse(
        job_id=job_id,
        status=job.get("status", "unknown"),
        proposals=job.get("proposals", []),
    )


@router.put("/{job_id}/proposals")
async def update_job_proposals(job_id: str, proposals: list[dict]):
    """Update proposals for a job (saves user edits to transitions/filters/brightness)."""
    from app.services.firestore import store_proposals

    job = get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    store_proposals(job_id, proposals)

    # Invalidate any stored exports since proposals changed
    from app.services.firestore import get_db
    from datetime import datetime, timezone
    db = get_db()
    db.collection("jobs").document(job_id).update({
        "exports": {},
        "updated_at": datetime.now(timezone.utc),
    })

    return {"status": "ok"}
