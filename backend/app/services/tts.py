"""Google Cloud Text-to-Speech service.

Synthesizes speech audio from text using Google Cloud TTS API.
Outputs LINEAR16 WAV format for easy ffmpeg mixing.
Uploads rendered audio to GCS for playback.
"""

import os
from pathlib import Path
from typing import Optional

from google.cloud import texttospeech

from app.config import settings
from app.services.gcs_storage import get_bucket


# Curated voice options (English)
AVAILABLE_VOICES = [
    {
        "name": "en-US-Journey-D",
        "gender": "Male",
        "description": "Warm conversational",
        "language_code": "en-US",
    },
    {
        "name": "en-US-Journey-F",
        "gender": "Female",
        "description": "Warm conversational",
        "language_code": "en-US",
    },
    {
        "name": "en-US-Neural2-D",
        "gender": "Male",
        "description": "Clear professional",
        "language_code": "en-US",
    },
    {
        "name": "en-US-Neural2-C",
        "gender": "Female",
        "description": "Clear professional",
        "language_code": "en-US",
    },
    {
        "name": "en-US-Neural2-J",
        "gender": "Male",
        "description": "Deep",
        "language_code": "en-US",
    },
    {
        "name": "en-US-Neural2-E",
        "gender": "Female",
        "description": "Bright energetic",
        "language_code": "en-US",
    },
]


_client: Optional[texttospeech.TextToSpeechClient] = None


def _get_client() -> texttospeech.TextToSpeechClient:
    """Get a TTS client, resolving credentials path."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return texttospeech.TextToSpeechClient()


def get_client() -> texttospeech.TextToSpeechClient:
    """Get or create the TTS client singleton."""
    global _client
    if _client is None:
        _client = _get_client()
    return _client


def get_available_voices() -> list[dict]:
    """Return the curated list of available voices.

    Returns:
        List of voice dicts with name, gender, description, language_code.
    """
    return AVAILABLE_VOICES


def synthesize_speech(
    text: str,
    voice_name: str = "en-US-Journey-D",
    speaking_rate: float = 1.0,
) -> bytes:
    """Synthesize speech from text using Google Cloud TTS.

    Args:
        text: The text to synthesize into speech.
        voice_name: TTS voice name (e.g., "en-US-Journey-D").
        speaking_rate: Speed of speech (0.5 to 2.0, 1.0 = normal).

    Returns:
        WAV audio bytes (LINEAR16 format).

    Raises:
        ValueError: If text is empty or voice_name is not recognized.
        RuntimeError: If TTS API call fails.
    """
    if not text or not text.strip():
        raise ValueError("Text cannot be empty")

    # Clamp speaking rate to valid range
    speaking_rate = max(0.5, min(2.0, speaking_rate))

    # Find the voice in our curated list to get language_code
    language_code = "en-US"
    for voice in AVAILABLE_VOICES:
        if voice["name"] == voice_name:
            language_code = voice["language_code"]
            break

    client = get_client()

    synthesis_input = texttospeech.SynthesisInput(text=text)

    voice_params = texttospeech.VoiceSelectionParams(
        language_code=language_code,
        name=voice_name,
    )

    audio_config = texttospeech.AudioConfig(
        audio_encoding=texttospeech.AudioEncoding.LINEAR16,
        speaking_rate=speaking_rate,
        sample_rate_hertz=24000,
    )

    try:
        response = client.synthesize_speech(
            input=synthesis_input,
            voice=voice_params,
            audio_config=audio_config,
        )
    except Exception as e:
        raise RuntimeError(f"TTS API call failed: {e}")

    return response.audio_content


def upload_speech_to_gcs(
    audio_bytes: bytes,
    project_id: str,
    chunk_id: str,
) -> str:
    """Upload rendered speech audio to GCS.

    Path: projects/{project_id}/speech/{chunk_id}.wav

    Args:
        audio_bytes: WAV audio bytes to upload.
        project_id: Project identifier.
        chunk_id: Speech chunk identifier.

    Returns:
        Public GCS URL for playback.
    """
    bucket = get_bucket()
    blob_path = f"projects/{project_id}/speech/{chunk_id}.wav"
    blob = bucket.blob(blob_path)

    blob.upload_from_string(audio_bytes, content_type="audio/wav")

    return f"https://storage.googleapis.com/{settings.gcs_bucket_name}/{blob_path}"
