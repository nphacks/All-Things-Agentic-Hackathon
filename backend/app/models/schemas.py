"""Pydantic models for request/response schemas."""

from pydantic import BaseModel
from typing import Any, Optional


class HealthResponse(BaseModel):
    status: str
    service: str


class MessageResponse(BaseModel):
    message: str


class ClipMetadata(BaseModel):
    clip_id: str
    filename: str
    file_path: str
    size_bytes: int
    gcs_url: Optional[str] = None


class JobSettings(BaseModel):
    min_duration: int = 20
    max_duration: int = 30
    num_proposals: int = 3
    variations: list[str] = []
    add_transitions: bool = True
    allow_filters: bool = True
    auto_brightness: bool = True


class JobCreateRequest(BaseModel):
    brief: str
    clip_ids: list[str]
    settings: Optional[JobSettings] = None
    project_id: Optional[str] = None


class JobCreateResponse(BaseModel):
    job_id: str
    status: str


class JobStatusResponse(BaseModel):
    job_id: str
    status: str
    progress: Optional[str] = None
    brief: Optional[str] = None
    error: Optional[str] = None
    clips: list[dict[str, Any]] = []
    clip_analyses: dict[str, Any] = {}
    proposals: list[dict[str, Any]] = []
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProposalsResponse(BaseModel):
    job_id: str
    status: str
    proposals: list[dict[str, Any]] = []
