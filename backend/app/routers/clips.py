"""Clip upload endpoint -- uploads to GCS and registers metadata."""

import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.models.schemas import ClipMetadata
from app.services.clip_store import register_clip
from app.services.gcs_storage import upload_to_gcs
from app.services.projects import add_clip_to_project
from app.services.storage import (
    ALLOWED_EXTENSIONS,
    MAX_CLIPS_PER_UPLOAD,
    MAX_FILE_SIZE_BYTES,
    validate_clip,
)

router = APIRouter(prefix="/clips", tags=["clips"])


# Map extensions to MIME types for GCS upload
EXTENSION_MIME_MAP = {
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".webm": "video/webm",
}


@router.post("/upload", response_model=list[ClipMetadata])
async def upload_clips(
    files: list[UploadFile] = File(...),
    job_id: Optional[str] = Form(None),
    project_id: Optional[str] = Form(None),
):
    """Upload video clips to GCS.

    Accepts multiple video files (mp4, mov, webm). Max 200MB per file, max 10 files.
    If no job_id is provided, one is generated automatically.
    If project_id is provided, clips are stored under that project's GCS path.
    """
    # Generate job_id if not provided
    if not job_id:
        job_id = str(uuid.uuid4())

    # Use project_id for GCS path, fall back to job_id
    storage_id = project_id or job_id

    # Check max clip count
    if len(files) > MAX_CLIPS_PER_UPLOAD:
        raise HTTPException(
            status_code=400,
            detail=f"Too many files. Max {MAX_CLIPS_PER_UPLOAD} clips per upload.",
        )

    # Validate all files first
    errors = []
    for file in files:
        error = validate_clip(file)
        if error:
            errors.append(error)

    if errors:
        raise HTTPException(status_code=400, detail=errors)

    # Upload all clips to GCS
    results = []
    for file in files:
        try:
            # Read file content
            content = await file.read()
            size_bytes = len(content)

            if size_bytes > MAX_FILE_SIZE_BYTES:
                raise ValueError(
                    f"File '{file.filename}' is {size_bytes / 1024 / 1024:.1f}MB. "
                    f"Max allowed: {MAX_FILE_SIZE_BYTES / 1024 / 1024:.0f}MB."
                )

            clip_id = str(uuid.uuid4())
            storage_filename = f"{clip_id}_{file.filename}"

            # Determine content type
            from pathlib import Path
            ext = Path(file.filename).suffix.lower() if file.filename else ".mp4"
            content_type = EXTENSION_MIME_MAP.get(ext, "video/mp4")

            # Upload to GCS
            gcs_url = upload_to_gcs(content, storage_id, storage_filename, content_type)

            # Register in clip store for job lookup
            register_clip(
                clip_id=clip_id,
                filename=file.filename or "unknown.mp4",
                file_path=f"gcs://{storage_id}/{storage_filename}",
                size_bytes=size_bytes,
                job_id=job_id,
                gcs_url=gcs_url,
            )

            results.append(ClipMetadata(
                clip_id=clip_id,
                filename=file.filename or "unknown.mp4",
                file_path=f"gcs://{storage_id}/{storage_filename}",
                size_bytes=size_bytes,
                gcs_url=gcs_url,
            ))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    # Register clips in the project document if project_id was provided
    if project_id:
        for clip in results:
            add_clip_to_project(
                project_id=project_id,
                clip_id=clip.clip_id,
                filename=clip.filename,
                gcs_url=clip.gcs_url or "",
            )

    return results
