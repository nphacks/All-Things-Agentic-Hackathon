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
from app.services.projects import add_job_to_project

router = APIRouter(prefix="/jobs", tags=["jobs"])


@router.post("/create", response_model=JobCreateResponse)
async def create_job_endpoint(request: JobCreateRequest):
    """Create a new editing job and kick off the agent.

    Accepts a brief, clip IDs (from prior upload), and settings.
    Returns immediately with job_id and status 'pending'.
    The agent runs asynchronously in the background.
    """
    # Validate clip_ids exist
    clips = get_clips(request.clip_ids)
    if not clips:
        raise HTTPException(
            status_code=400,
            detail="No valid clip_ids provided. Upload clips first via POST /clips/upload.",
        )

    missing = set(request.clip_ids) - {c["clip_id"] for c in clips}
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown clip_ids: {list(missing)}. Upload clips first.",
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
