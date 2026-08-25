"""Speech re-rendering endpoints.

Allows re-rendering individual speech chunks with updated text, voice, or rate.
Single chunk rendering is fast (2-5 seconds) so runs synchronously.
"""

from pydantic import BaseModel
from fastapi import APIRouter, HTTPException

from app.services.tts import synthesize_speech, upload_speech_to_gcs
from app.services.speech_renderer import _get_wav_duration


router = APIRouter(prefix="/projects/{project_id}/speech", tags=["speech"])


class RenderChunkRequest(BaseModel):
    chunk_id: str
    text: str
    voice: str = "en-US-Journey-D"
    speaking_rate: float = 1.0


class RenderChunkResponse(BaseModel):
    chunk_id: str
    text: str
    voice: str
    speaking_rate: float
    gcs_url: str
    audio_duration: float


@router.post("/render", response_model=RenderChunkResponse)
def render_speech_chunk(project_id: str, request: RenderChunkRequest):
    """Re-render a single speech chunk with updated text/voice/rate.

    Synthesizes TTS audio, uploads to GCS (overwrites previous), and returns
    the updated chunk data with actual audio duration.

    Fast operation: typically 2-5 seconds for a single chunk.
    """
    if not request.text or not request.text.strip():
        raise HTTPException(status_code=400, detail="Text cannot be empty")

    # Clamp speaking rate
    speaking_rate = max(0.5, min(2.0, request.speaking_rate))

    # Synthesize speech
    try:
        audio_bytes = synthesize_speech(
            text=request.text,
            voice_name=request.voice,
            speaking_rate=speaking_rate,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except RuntimeError as e:
        raise HTTPException(status_code=502, detail=str(e))

    # Upload to GCS (overwrites existing file at same path)
    try:
        gcs_url = upload_speech_to_gcs(audio_bytes, project_id, request.chunk_id)
    except Exception as e:
        raise HTTPException(status_code=502, detail=f"Upload failed: {e}")

    # Get actual audio duration
    audio_duration = _get_wav_duration(audio_bytes)

    return RenderChunkResponse(
        chunk_id=request.chunk_id,
        text=request.text,
        voice=request.voice,
        speaking_rate=speaking_rate,
        gcs_url=gcs_url,
        audio_duration=round(audio_duration, 2),
    )
