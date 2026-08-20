"""Export endpoints for rendering proposals to MP4 via ffmpeg."""

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.exporter import export_proposal
from app.services.projects import get_project
from app.services.firestore import get_db, get_job


router = APIRouter(prefix="/projects/{project_id}/export", tags=["export"])

# In-memory export job tracking (for active renders)
_export_jobs: dict[str, dict[str, Any]] = {}


class ExportRequest(BaseModel):
    proposal_index: int = 0
    proposal: Optional[dict[str, Any]] = None
    job_id: Optional[str] = None


class ExportStatusResponse(BaseModel):
    export_id: str
    status: str
    progress: Optional[str] = None
    download_url: Optional[str] = None
    error: Optional[str] = None


def _get_stored_export(job_id: str, proposal_index: int) -> Optional[dict]:
    """Get stored export info from Firestore job document."""
    db = get_db()
    doc = db.collection("jobs").document(job_id).get()
    if not doc.exists:
        return None
    data = doc.to_dict()
    exports = data.get("exports", {})
    return exports.get(str(proposal_index))


def _store_export(job_id: str, proposal_index: int, download_url: str):
    """Store export URL in Firestore job document."""
    db = get_db()
    db.collection("jobs").document(job_id).update({
        f"exports.{proposal_index}": {
            "url": download_url,
            "exported_at": datetime.now(timezone.utc).isoformat(),
        },
        "updated_at": datetime.now(timezone.utc),
    })


def _invalidate_export(job_id: str, proposal_index: int):
    """Remove stored export when proposal is edited."""
    db = get_db()
    try:
        db.collection("jobs").document(job_id).update({
            f"exports.{proposal_index}": None,
        })
    except Exception:
        pass


@router.post("", response_model=ExportStatusResponse)
async def start_export(project_id: str, request: ExportRequest):
    """Start an async export job for a proposal."""
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    # Resolve proposal
    proposal_data = request.proposal
    job_id = request.job_id

    if not proposal_data and job_id:
        job = get_job(job_id)
        if not job:
            raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
        proposals = job.get("proposals", [])
        if request.proposal_index >= len(proposals):
            raise HTTPException(status_code=400, detail="Proposal index out of range.")
        proposal_data = proposals[request.proposal_index]

    if not proposal_data:
        raise HTTPException(status_code=400, detail="No proposal data.")

    # Check if there's already a stored export for this proposal
    if job_id:
        stored = _get_stored_export(job_id, request.proposal_index)
        if stored and stored.get("url"):
            return ExportStatusResponse(
                export_id="cached",
                status="completed",
                download_url=stored["url"],
                progress="Previously exported",
            )

    # Build clips info
    clips_info = project.get("clips", [])
    if job_id:
        job = get_job(job_id)
        if job and job.get("clips"):
            for jc in job["clips"]:
                existing = next((c for c in clips_info if c.get("clip_id") == jc.get("clip_id")), None)
                if not existing:
                    clips_info.append(jc)
                elif "file_path" not in existing:
                    existing["file_path"] = jc.get("file_path", "")

    # Create export job
    export_id = str(uuid.uuid4())
    _export_jobs[export_id] = {
        "status": "pending",
        "progress": "Starting export...",
        "download_url": None,
        "error": None,
    }

    asyncio.create_task(
        _run_export(export_id, proposal_data, project_id, clips_info, job_id, request.proposal_index)
    )

    return ExportStatusResponse(
        export_id=export_id,
        status="pending",
        progress="Starting export...",
    )


@router.get("/{export_id}", response_model=ExportStatusResponse)
async def get_export_status_endpoint(project_id: str, export_id: str):
    """Check export job status."""
    job = _export_jobs.get(export_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Export '{export_id}' not found.")

    return ExportStatusResponse(
        export_id=export_id,
        status=job["status"],
        progress=job.get("progress"),
        download_url=job.get("download_url"),
        error=job.get("error"),
    )


async def _run_export(
    export_id: str,
    proposal: dict[str, Any],
    project_id: str,
    clips_info: list[dict[str, Any]],
    job_id: Optional[str],
    proposal_index: int,
):
    """Background task to render the export."""
    try:
        _export_jobs[export_id]["status"] = "rendering"
        _export_jobs[export_id]["progress"] = "Rendering..."

        loop = asyncio.get_event_loop()
        download_url = await loop.run_in_executor(
            None, export_proposal, proposal, project_id, clips_info,
        )

        _export_jobs[export_id]["status"] = "completed"
        _export_jobs[export_id]["progress"] = "Export complete"
        _export_jobs[export_id]["download_url"] = download_url

        # Store in Firestore for persistence
        if job_id:
            _store_export(job_id, proposal_index, download_url)

    except Exception as e:
        _export_jobs[export_id]["status"] = "failed"
        _export_jobs[export_id]["error"] = str(e)
        _export_jobs[export_id]["progress"] = "Export failed"
