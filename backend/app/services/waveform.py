"""Waveform extraction utility.

Extracts amplitude data from a video's audio track using ffmpeg.
Produces a downsampled array of peak amplitudes (0.0-1.0) suitable
for timeline visualization.
"""

import struct
import subprocess
from pathlib import Path


def _has_audio_stream(video_path: str) -> bool:
    """Check if a video file has an audio stream using ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-select_streams", "a",
                "-show_entries", "stream=index",
                "-of", "csv=p=0",
                video_path,
            ],
            capture_output=True,
            text=True,
            timeout=10,
        )
        return bool(result.stdout.strip())
    except (subprocess.TimeoutExpired, FileNotFoundError):
        return False


def extract_waveform(video_path: str, num_points: int = 150) -> list[float]:
    """Extract waveform amplitude data from a video's audio track.

    Uses ffmpeg to extract audio as raw mono PCM, then computes peak
    amplitude per time window, downsampled to the requested number of
    data points.

    Args:
        video_path: Absolute path to the video file.
        num_points: Number of amplitude data points to produce (default 150).
                    Should be 100-200 for timeline visualization.

    Returns:
        List of floats (0.0 to 1.0) representing peak amplitude per window.
        Returns array of zeros if the video has no audio track.
    """
    file_path = Path(video_path)
    if not file_path.exists():
        return [0.0] * num_points

    # Check for audio stream
    if not _has_audio_stream(video_path):
        return [0.0] * num_points

    # Extract audio as raw mono 16-bit PCM at 8000 Hz
    # This gives us manageable data: 30s clip = 240,000 samples = ~480KB
    sample_rate = 8000
    try:
        result = subprocess.run(
            [
                "ffmpeg",
                "-i", video_path,
                "-ac", "1",           # mono
                "-ar", str(sample_rate),  # 8000 Hz
                "-f", "s16le",        # signed 16-bit little-endian PCM
                "-v", "quiet",
                "-",                  # pipe to stdout
            ],
            capture_output=True,
            timeout=30,
        )
    except subprocess.TimeoutExpired:
        return [0.0] * num_points
    except FileNotFoundError:
        # ffmpeg not installed
        return [0.0] * num_points

    raw_bytes = result.stdout
    if not raw_bytes:
        return [0.0] * num_points

    # Parse raw PCM: each sample is 2 bytes (signed 16-bit LE)
    num_samples = len(raw_bytes) // 2
    if num_samples == 0:
        return [0.0] * num_points

    # Unpack all samples at once
    samples = struct.unpack(f"<{num_samples}h", raw_bytes[:num_samples * 2])

    # Divide into windows and compute peak amplitude per window
    samples_per_window = max(1, num_samples // num_points)
    waveform = []

    for i in range(num_points):
        start = i * samples_per_window
        end = min(start + samples_per_window, num_samples)
        if start >= num_samples:
            waveform.append(0.0)
            continue

        # Peak absolute amplitude in this window, normalized to 0.0-1.0
        window = samples[start:end]
        peak = max(abs(s) for s in window) if window else 0
        normalized = min(peak / 32767.0, 1.0)
        waveform.append(round(normalized, 4))

    return waveform
