from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.routers import jobs, clips, projects, exports
from app.models.schemas import HealthResponse
from app.config import settings as app_settings

import os
from pathlib import Path

app = FastAPI(
    title="Ad Cut Agent API",
    description="AI video editing agent that generates cut proposals from raw clips and a creative brief.",
    version="0.1.0",
)

# CORS -- allow all origins for development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve uploaded clips as static files at /media/
uploads_path = Path(app_settings.upload_dir)
uploads_path.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(uploads_path)), name="media")

# Routers
app.include_router(jobs.router)
app.include_router(clips.router)
app.include_router(projects.router)
app.include_router(exports.router)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(status="ok", service="ad-cut-agent")
