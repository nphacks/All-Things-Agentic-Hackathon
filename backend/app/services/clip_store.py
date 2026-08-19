"""In-memory clip metadata store.

Tracks uploaded clips so the job endpoint can look up file paths by clip_id.
In production, this would be backed by Firestore or a database.
For v1, this lives in memory (resets on server restart).
"""

from typing import Optional


# clip_id -> metadata dict
_clip_store: dict[str, dict] = {}


def register_clip(clip_id: str, filename: str, file_path: str, size_bytes: int, job_id: str) -> None:
    """Register an uploaded clip in the store."""
    _clip_store[clip_id] = {
        "clip_id": clip_id,
        "filename": filename,
        "file_path": file_path,
        "size_bytes": size_bytes,
        "job_id": job_id,
    }


def get_clip(clip_id: str) -> Optional[dict]:
    """Get clip metadata by ID. Returns None if not found."""
    return _clip_store.get(clip_id)


def get_clips(clip_ids: list[str]) -> list[dict]:
    """Get metadata for multiple clips. Skips unknown IDs."""
    return [_clip_store[cid] for cid in clip_ids if cid in _clip_store]


def list_all_clips() -> list[dict]:
    """List all registered clips."""
    return list(_clip_store.values())
