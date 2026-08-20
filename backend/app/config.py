from pydantic_settings import BaseSettings
from pathlib import Path


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    # Google Cloud
    google_cloud_project: str = ""
    google_application_credentials: str = ""
    firestore_database: str = "all-things-agent-hackathon"

    # GCS storage
    gcs_bucket_name: str = "all-things-agentic-hackathon-projects"

    # File storage (legacy local)
    upload_dir: str = "uploads"

    # Server
    host: str = "0.0.0.0"
    port: int = 8080

    class Config:
        env_file = ".env"
        env_file_encoding = "utf-8"
        extra = "ignore"


settings = Settings()
