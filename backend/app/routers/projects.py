"""Project CRUD endpoints."""

from typing import Any, Optional

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services.projects import (
    create_project,
    get_project,
    list_projects,
    update_project,
)

router = APIRouter(prefix="/projects", tags=["projects"])


class ProjectCreateRequest(BaseModel):
    name: str


class ProjectUpdateRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None


class ProjectResponse(BaseModel):
    project_id: str
    name: str
    clips: list[dict[str, Any]] = []
    jobs: list[str] = []
    status: str = "active"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None


class ProjectListItem(BaseModel):
    project_id: str
    name: str
    clip_count: int = 0
    job_count: int = 0
    status: str = "active"
    created_at: Optional[str] = None
    updated_at: Optional[str] = None
    thumbnail_url: Optional[str] = None


@router.post("", response_model=ProjectResponse)
async def create_project_endpoint(request: ProjectCreateRequest):
    """Create a new project."""
    project = create_project(request.name)
    return _format_project_response(project)


@router.get("", response_model=list[ProjectListItem])
async def list_projects_endpoint():
    """List all active projects (for landing page)."""
    projects = list_projects()
    return [
        ProjectListItem(
            project_id=p["project_id"],
            name=p.get("name", "Untitled"),
            clip_count=len(p.get("clips", [])),
            job_count=len(p.get("jobs", [])),
            status=p.get("status", "active"),
            created_at=str(p["created_at"]) if p.get("created_at") else None,
            updated_at=str(p["updated_at"]) if p.get("updated_at") else None,
            thumbnail_url=p["clips"][0].get("gcs_url") if p.get("clips") else None,
        )
        for p in projects
    ]


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project_endpoint(project_id: str):
    """Get a project with its clips and jobs."""
    project = get_project(project_id)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return _format_project_response(project)


@router.patch("/{project_id}", response_model=ProjectResponse)
async def update_project_endpoint(project_id: str, request: ProjectUpdateRequest):
    """Update project name or status."""
    update_data = {}
    if request.name is not None:
        update_data["name"] = request.name
    if request.status is not None:
        if request.status not in ("active", "archived"):
            raise HTTPException(status_code=400, detail="Status must be 'active' or 'archived'.")
        update_data["status"] = request.status

    if not update_data:
        raise HTTPException(status_code=400, detail="No fields to update.")

    project = update_project(project_id, update_data)
    if not project:
        raise HTTPException(status_code=404, detail=f"Project '{project_id}' not found.")
    return _format_project_response(project)


def _format_project_response(project: dict[str, Any]) -> ProjectResponse:
    """Convert Firestore project dict to response model."""
    return ProjectResponse(
        project_id=project["project_id"],
        name=project.get("name", "Untitled"),
        clips=project.get("clips", []),
        jobs=project.get("jobs", []),
        status=project.get("status", "active"),
        created_at=str(project["created_at"]) if project.get("created_at") else None,
        updated_at=str(project["updated_at"]) if project.get("updated_at") else None,
    )
