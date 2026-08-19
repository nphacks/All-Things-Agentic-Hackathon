"""Local file storage service for uploaded video clips."""

import uuid
from pathlib import Path

from fastapi import UploadFile

from app.config import settings


ALLOWED_CONTENT_TYPES = {
    "video/mp4",
    "video/quicktime",
    "video/webm",
}

ALLOWED_EXTENSIONS = {".mp4", ".mov", ".webm"}

MAX_FILE_SIZE_BYTES = 200 * 1024 * 1024  # 200MB
MAX_CLIPS_PER_UPLOAD = 10


def get_upload_dir(job_id: str) -> Path:
    """Get (and create) the upload directory for a job."""
    upload_path = Path(settings.upload_dir) / job_id
    upload_path.mkdir(parents=True, exist_ok=True)
    return upload_path


def validate_clip(file: UploadFile) -> str | None:
    """Validate a single clip file. Returns error message or None if valid."""
    # Check extension (primary validation)
    if file.filename:
        ext = Path(file.filename).suffix.lower()
        if ext not in ALLOWED_EXTENSIONS:
            return f"Invalid extension '{ext}' for '{file.filename}'. Allowed: .mp4, .mov, .webm."
    else:
        return "File has no filename."

    # Check content type (allow application/octet-stream since some clients don't set MIME)
    if file.content_type and file.content_type not in ALLOWED_CONTENT_TYPES | {"application/octet-stream"}:
        return f"Invalid file type '{file.content_type}' for '{file.filename}'. Allowed: mp4, mov, webm."

    return None


async def save_clip(file: UploadFile, job_id: str) -> dict:
    """Save an uploaded clip to disk. Returns clip metadata."""
    clip_id = str(uuid.uuid4())
    upload_dir = get_upload_dir(job_id)

    # Read file content
    content = await file.read()

    # Check file size
    size_bytes = len(content)
    if size_bytes > MAX_FILE_SIZE_BYTES:
        raise ValueError(
            f"File '{file.filename}' is {size_bytes / 1024 / 1024:.1f}MB. Max allowed: 100MB."
        )

    # Save to disk
    file_path = upload_dir / f"{clip_id}_{file.filename}"
    file_path.write_bytes(content)

    return {
        "clip_id": clip_id,
        "filename": file.filename,
        "file_path": str(file_path),
        "size_bytes": size_bytes,
    }
