"""Speech rendering pipeline.

Renders agent-generated speech chunks into audio files via Google Cloud TTS,
uploads to GCS, and calculates actual audio duration using ffprobe.
All chunks render concurrently for speed.
"""

import asyncio
import subprocess
from concurrent.futures import ThreadPoolExecutor

from app.services.tts import synthesize_speech, upload_speech_to_gcs


# Thread pool for running blocking TTS/upload calls in async context
_executor = ThreadPoolExecutor(max_workers=6)


def _get_wav_duration(audio_bytes: bytes) -> float:
    """Get the duration of WAV audio bytes using ffprobe.

    Writes to a temp file since ffprobe pipe input can be unreliable with WAV headers.

    Args:
        audio_bytes: Raw WAV audio bytes.

    Returns:
        Duration in seconds (float). Returns 0.0 on error.
    """
    import tempfile
    tmp_path = None
    try:
        # Write to temp file (ffprobe handles WAV files better from disk)
        with tempfile.NamedTemporaryFile(suffix=".wav", delete=False) as tmp:
            tmp.write(audio_bytes)
            tmp_path = tmp.name

        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-show_entries", "format=duration",
                "-of", "csv=p=0",
                tmp_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        duration_str = result.stdout.strip()
        if duration_str:
            return float(duration_str)
    except (subprocess.TimeoutExpired, ValueError, FileNotFoundError, OSError):
        pass
    finally:
        if tmp_path:
            import os
            try:
                os.unlink(tmp_path)
            except OSError:
                pass
    return 0.0


def _render_single_chunk(
    chunk: dict,
    project_id: str,
    voice_name: str,
) -> dict:
    """Render a single speech chunk: synthesize, upload, measure duration.

    This is a blocking function meant to run in a thread pool.

    Args:
        chunk: Speech chunk dict with chunk_id, text, speaking_rate, etc.
        project_id: Project identifier for GCS path.
        voice_name: TTS voice to use.

    Returns:
        Updated chunk dict with gcs_url, audio_duration, and overflow_flag.
    """
    chunk_id = chunk.get("chunk_id", "sp_unknown")
    text = chunk.get("text", "")
    speaking_rate = chunk.get("speaking_rate", 1.0)
    start_time = chunk.get("start_time", 0.0)
    end_time = chunk.get("end_time", 0.0)
    allocated_duration = end_time - start_time

    # Skip empty text
    if not text or not text.strip():
        chunk["gcs_url"] = None
        chunk["audio_duration"] = 0.0
        chunk["skipped"] = True
        return chunk

    # Synthesize speech
    try:
        audio_bytes = synthesize_speech(
            text=text,
            voice_name=voice_name,
            speaking_rate=speaking_rate,
        )
    except Exception as e:
        chunk["gcs_url"] = None
        chunk["audio_duration"] = 0.0
        chunk["render_error"] = str(e)
        return chunk

    # Upload to GCS
    try:
        gcs_url = upload_speech_to_gcs(audio_bytes, project_id, chunk_id)
    except Exception as e:
        chunk["gcs_url"] = None
        chunk["audio_duration"] = 0.0
        chunk["render_error"] = f"Upload failed: {e}"
        return chunk

    # Get actual audio duration
    audio_duration = _get_wav_duration(audio_bytes)

    # Update chunk data
    chunk["gcs_url"] = gcs_url
    chunk["audio_duration"] = round(audio_duration, 2)

    # Flag overflow if rendered audio is longer than allocated slot
    if audio_duration > 0 and allocated_duration > 0:
        if audio_duration > allocated_duration + 0.5:  # 0.5s tolerance
            chunk["overflow_flag"] = True
            # Adjust end_time to reflect actual duration
            chunk["end_time"] = round(start_time + audio_duration, 2)
        else:
            chunk["overflow_flag"] = False
    else:
        chunk["overflow_flag"] = False

    return chunk


async def render_speech_chunks(
    chunks: list[dict],
    project_id: str,
    voice_name: str,
) -> list[dict]:
    """Render all speech chunks concurrently.

    For each chunk: synthesizes TTS audio, uploads to GCS, measures actual duration.
    Runs all chunks in parallel using a thread pool executor.

    Args:
        chunks: List of speech chunk dicts from generate_speech_script.
        project_id: Project identifier for GCS paths.
        voice_name: TTS voice name to use for all chunks.

    Returns:
        Updated chunks list with gcs_url, audio_duration, and overflow_flag added.
    """
    if not chunks:
        return []

    loop = asyncio.get_event_loop()

    # Create tasks for each chunk
    tasks = []
    for chunk in chunks:
        task = loop.run_in_executor(
            _executor,
            _render_single_chunk,
            chunk,
            project_id,
            voice_name,
        )
        tasks.append(task)

    # Run all concurrently
    rendered_chunks = await asyncio.gather(*tasks)
    return list(rendered_chunks)
