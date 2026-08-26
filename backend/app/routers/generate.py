"""Media generation endpoints (side-car feature).

Veo video generation: prompt -> Veo on Vertex AI -> MP4 in GCS -> registered as
a clip in the project's library (usable like an upload). Async job + polling.
"""

import asyncio
import uuid
from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.veo import generate_video
from app.services.projects import get_project, add_clip_to_project


router = APIRouter(prefix="/projects/{project_id}/generate", tags=["generate"])

# In-memory generation job tracking
_gen_jobs: dict[str, dict[str, Any]] = {}


class VideoGenRequest(BaseModel):
    prompt: str
    aspect_ratio: str = "16:9"
    duration: int = 6


class GeneratedClip(BaseModel):
    clip_id: str
    filename: str
    file_path: str
    gcs_url: str
    source: str = "generated"


class VideoGenStatusResponse(BaseModel):
    gen_id: str
    status: str
    progress: Optional[str] = None
    clip: Optional[GeneratedClip] = None
    error: Optional[str] = None


@router.post("/video", response_model=VideoGenStatusResponse)
async def start_video_generation(project_id: str, request: VideoGenRequest):
    """Start an async Veo video generation job."""
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")

    if not request.prompt or not request.prompt.strip():
        raise HTTPException(status_code=400, detail="Prompt cannot be empty.")

    if request.aspect_ratio not in ("16:9", "9:16", "1:1"):
        raise HTTPException(status_code=400, detail="aspect_ratio must be 16:9, 9:16, or 1:1.")

    gen_id = str(uuid.uuid4())
    _gen_jobs[gen_id] = {
        "status": "pending",
        "progress": "Starting generation...",
        "clip": None,
        "error": None,
    }

    asyncio.create_task(
        _run_video_generation(gen_id, project_id, request.prompt, request.aspect_ratio, request.duration)
    )

    return VideoGenStatusResponse(gen_id=gen_id, status="pending", progress="Starting generation...")


@router.get("/video/{gen_id}", response_model=VideoGenStatusResponse)
async def get_video_generation_status(project_id: str, gen_id: str):
    """Poll the status of a video generation job."""
    job = _gen_jobs.get(gen_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Generation '{gen_id}' not found.")

    clip = None
    if job.get("clip"):
        clip = GeneratedClip(**job["clip"])

    return VideoGenStatusResponse(
        gen_id=gen_id,
        status=job["status"],
        progress=job.get("progress"),
        clip=clip,
        error=job.get("error"),
    )


async def _run_video_generation(
    gen_id: str,
    project_id: str,
    prompt: str,
    aspect_ratio: str,
    duration: int,
):
    """Background task: generate video, save to GCS, register as a project clip."""
    try:
        _gen_jobs[gen_id]["status"] = "generating"
        _gen_jobs[gen_id]["progress"] = "Generating video with Veo (this can take a minute)..."

        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            None, generate_video, prompt, project_id, aspect_ratio, duration
        )

        if result.get("status") != "success":
            _gen_jobs[gen_id]["status"] = "failed"
            _gen_jobs[gen_id]["error"] = result.get("error", "Generation failed")
            _gen_jobs[gen_id]["progress"] = "Generation failed"
            return

        # Register the generated clip in the project's library (marked as generated)
        add_clip_to_project(
            project_id=project_id,
            clip_id=result["clip_id"],
            filename=result["filename"],
            gcs_url=result["gcs_url"],
            source="generated",
        )

        clip = {
            "clip_id": result["clip_id"],
            "filename": result["filename"],
            "file_path": result["file_path"],
            "gcs_url": result["gcs_url"],
            "source": "generated",
        }
        _gen_jobs[gen_id]["status"] = "completed"
        _gen_jobs[gen_id]["progress"] = "Generation complete"
        _gen_jobs[gen_id]["clip"] = clip

    except Exception as e:
        _gen_jobs[gen_id]["status"] = "failed"
        _gen_jobs[gen_id]["error"] = str(e)
        _gen_jobs[gen_id]["progress"] = "Generation failed"
