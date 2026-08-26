"""Veo video generation service (side-car feature, not part of the editing pipeline).

Generates a short video from a text prompt via Veo on Vertex AI, saves the
resulting MP4 to GCS, and returns the public URL. Designed to be called from a
background task (generation takes time) with status polling in the router.

Uses Veo 3 Fast for cost efficiency.
"""

import logging
import os
import time
import uuid
from pathlib import Path

from google import genai
from google.genai import types

from app.config import settings
from app.services.gcs_storage import upload_to_gcs

logger = logging.getLogger("veo")

# Veo 3 Fast -- cheaper per-second than standard Veo.
# The publisher model template requires the version suffix (@default); without it
# Vertex returns 404 on the regional predictLongRunning endpoint.
VEO_MODEL = "veo-3.0-fast-generate-001@default"

# Poll settings for the long-running generation operation.
_POLL_INTERVAL_SECONDS = 10
_POLL_TIMEOUT_SECONDS = 300


def _get_genai_client():
    """Get a google-genai client configured for Vertex AI (global endpoint)."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    # Veo is served on REGIONAL endpoints (not the `global` endpoint that Gemini uses).
    # Using global returns 404 for Veo models.
    return genai.Client(
        vertexai=True,
        project=settings.google_cloud_project,
        location="us-central1",
    )


def generate_video(
    prompt: str,
    project_id: str,
    aspect_ratio: str = "16:9",
    duration_seconds: int = 6,
) -> dict:
    """Generate a video with Veo and save it to GCS.

    Blocking function (polls the long-running operation to completion). Intended
    to run inside a background executor.

    Args:
        prompt: Text description of the video to generate.
        project_id: Project to store the generated clip under (GCS path prefix).
        aspect_ratio: "16:9", "9:16", or "1:1".
        duration_seconds: Target clip length in seconds.

    Returns:
        dict: {status, gcs_url, filename, clip_id} on success, or {status, error}.
    """
    if not prompt or not prompt.strip():
        return {"status": "error", "error": "Prompt cannot be empty"}

    client = _get_genai_client()

    config = types.GenerateVideosConfig(
        aspect_ratio=aspect_ratio,
        duration_seconds=duration_seconds,
        number_of_videos=1,
    )

    try:
        operation = client.models.generate_videos(
            model=VEO_MODEL,
            prompt=prompt.strip(),
            config=config,
        )
    except Exception as e:
        logger.warning(f"Veo generation start failed: {e}")
        return {"status": "error", "error": f"Failed to start generation: {e}"}

    # Poll the operation to completion
    elapsed = 0
    try:
        while not operation.done:
            if elapsed >= _POLL_TIMEOUT_SECONDS:
                return {"status": "error", "error": "Generation timed out"}
            time.sleep(_POLL_INTERVAL_SECONDS)
            elapsed += _POLL_INTERVAL_SECONDS
            operation = client.operations.get(operation)
    except Exception as e:
        logger.warning(f"Veo polling failed: {e}")
        return {"status": "error", "error": f"Generation polling failed: {e}"}

    # Extract the generated video
    try:
        response = operation.response
        generated = response.generated_videos
        if not generated:
            return {"status": "error", "error": "No video was generated"}

        video = generated[0].video
        # The SDK returns the video bytes (video.video_bytes) or a URI.
        video_bytes = getattr(video, "video_bytes", None)
        if video_bytes is None:
            # Some responses attach a file that must be downloaded first.
            try:
                client.files.download(file=video)
                video_bytes = getattr(video, "video_bytes", None)
            except Exception:
                video_bytes = None

        if not video_bytes:
            return {"status": "error", "error": "Generated video had no downloadable bytes"}
    except Exception as e:
        logger.warning(f"Veo response extraction failed: {e}")
        return {"status": "error", "error": f"Failed to read generated video: {e}"}

    # Save to GCS as a clip in the project's library
    clip_id = str(uuid.uuid4())
    safe_prompt = "".join(c for c in prompt.strip()[:30] if c.isalnum() or c in " -_").strip().replace(" ", "-")
    filename = f"generated-{safe_prompt or 'video'}.mp4"
    storage_filename = f"{clip_id}_{filename}"

    try:
        gcs_url = upload_to_gcs(video_bytes, project_id, storage_filename, content_type="video/mp4")
    except Exception as e:
        logger.warning(f"Veo GCS upload failed: {e}")
        return {"status": "error", "error": f"Failed to save generated video: {e}"}

    return {
        "status": "success",
        "clip_id": clip_id,
        "filename": filename,
        "file_path": f"gcs://{project_id}/{storage_filename}",
        "gcs_url": gcs_url,
    }
