import uuid
from typing import Optional

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.models.schemas import ClipMetadata
from app.services.clip_store import register_clip
from app.services.storage import (
    MAX_CLIPS_PER_UPLOAD,
    save_clip,
    validate_clip,
)

router = APIRouter(prefix="/clips", tags=["clips"])


@router.post("/upload", response_model=list[ClipMetadata])
async def upload_clips(
    files: list[UploadFile] = File(...),
    job_id: Optional[str] = Form(None),
):
    """Upload video clips for editing.

    Accepts multiple video files (mp4, mov, webm). Max 100MB per file, max 10 files.
    If no job_id is provided, one is generated automatically.
    """
    # Generate job_id if not provided
    if not job_id:
        job_id = str(uuid.uuid4())

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

    # Save all clips
    results = []
    for file in files:
        try:
            metadata = await save_clip(file, job_id)
            # Register in clip store for later lookup
            register_clip(
                clip_id=metadata["clip_id"],
                filename=metadata["filename"],
                file_path=metadata["file_path"],
                size_bytes=metadata["size_bytes"],
                job_id=job_id,
            )
            results.append(ClipMetadata(**metadata))
        except ValueError as e:
            raise HTTPException(status_code=400, detail=str(e))

    return results
