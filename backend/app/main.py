from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routers import jobs, clips
from app.models.schemas import HealthResponse

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

# Routers
app.include_router(jobs.router)
app.include_router(clips.router)


@app.get("/health", response_model=HealthResponse)
async def health_check():
    return HealthResponse(status="ok", service="ad-cut-agent")
