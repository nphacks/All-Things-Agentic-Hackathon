"""Video export service using ffmpeg.

Renders a proposal into a single MP4 file with mixed audio.
Strategy:
1. Download clips from GCS
2. Trim segments with filters (video only)
3. Apply xfade transitions iteratively between segments
4. Build original audio track (with volume keyframes)
5. Build speech audio track (WAVs at correct offsets)
6. Build music audio track (trimmed + volume keyframes)
7. Mix all audio layers + mux with video
8. Upload final to GCS
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

import requests as http_requests

from app.services.gcs_storage import upload_to_gcs


def _get_filter_string(segment: dict) -> str:
    """Build ffmpeg video filter for segment's filter + brightness."""
    filters = []

    brightness = segment.get("brightness_adjustment")
    if brightness and brightness != 1.0:
        offset = (brightness - 1.0) * 0.5
        filters.append(f"eq=brightness={offset:.3f}")

    seg_filter = segment.get("filter")
    if seg_filter and isinstance(seg_filter, dict):
        filter_type = seg_filter.get("type", "none")
        intensity = seg_filter.get("intensity", 1.0)

        if filter_type == "grayscale":
            filters.append(f"hue=s={1.0 - intensity:.2f}")
        elif filter_type == "sepia":
            filters.append(f"hue=s={1.0 - intensity * 0.7:.2f}")
            filters.append(f"colorbalance=rs={intensity * 0.3:.2f}:gs={intensity * 0.1:.2f}:bs={-intensity * 0.2:.2f}")
        elif filter_type == "high_contrast":
            filters.append(f"eq=contrast={1.0 + intensity * 0.5:.2f}")
        elif filter_type == "warm":
            filters.append(f"colorbalance=rs={intensity * 0.2:.2f}:gs={intensity * 0.1:.2f}:bs={-intensity * 0.15:.2f}")
        elif filter_type == "cool":
            filters.append(f"colorbalance=rs={-intensity * 0.1:.2f}:gs=0:bs={intensity * 0.2:.2f}")
        elif filter_type == "vintage":
            filters.append(f"hue=s={1.0 - intensity * 0.3:.2f}")
            filters.append(f"colorbalance=rs={intensity * 0.15:.2f}:gs={intensity * 0.05:.2f}:bs={-intensity * 0.1:.2f}")
        elif filter_type == "dramatic":
            filters.append(f"eq=contrast={1.0 + intensity * 0.4:.2f}:brightness={-intensity * 0.08:.3f}")

    return ",".join(filters) if filters else ""


def _get_xfade_name(transition_type: str) -> str:
    """Map transition types to ffmpeg xfade names."""
    return {
        "crossfade": "fade",
        "fade_to_black": "fadeblack",
        "fade_to_white": "fadewhite",
        "wipe_left": "wipeleft",
        "wipe_right": "wiperight",
        "zoom_in": "smoothup",
        "blur": "smoothleft",
    }.get(transition_type, "fade")


def _resolve_clip_path(segment: dict, clip_map: dict[str, str]) -> Optional[str]:
    """Find local file path for a segment's clip."""
    clip_id = segment.get("clip_id", "")
    filename = segment.get("filename", "")

    if clip_id in clip_map:
        return clip_map[clip_id]
    if filename in clip_map:
        return clip_map[filename]

    # Extract basename from path-like clip_id
    if "/" in clip_id:
        basename = os.path.basename(clip_id)
        if basename in clip_map:
            return clip_map[basename]
        bn_parts = basename.split("_", 1)
        if len(bn_parts) > 1 and bn_parts[1] in clip_map:
            return clip_map[bn_parts[1]]

    # Match by filename without extension
    clean = filename.rsplit(".", 1)[0] if "." in filename else filename
    if clean in clip_map:
        return clip_map[clean]

    # Fuzzy
    for key, path in clip_map.items():
        if filename and (filename in key or key in filename):
            return path
        if clean and (clean in key or key in clean):
            return path

    return None


def _get_duration(filepath: str) -> float:
    """Get duration of a video file via ffprobe."""
    result = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", filepath],
        capture_output=True, text=True, timeout=10
    )
    try:
        return float(result.stdout.strip())
    except (ValueError, AttributeError):
        return 5.0


def _build_volume_filter(keyframes: list[dict], total_duration: float) -> str:
    """Convert volume keyframes to an ffmpeg volume filter expression.

    Builds a piecewise linear interpolation using nested if/between expressions.
    """
    if not keyframes or len(keyframes) == 0:
        return "volume=1.0"

    # Sort by time
    kfs = sorted(keyframes, key=lambda k: k.get("time", 0))

    if len(kfs) == 1:
        return f"volume={kfs[0].get('volume', 1.0)}"

    # Build piecewise expression
    # For each pair of keyframes, interpolate linearly between them
    parts = []
    for i in range(len(kfs) - 1):
        t1 = kfs[i].get("time", 0)
        v1 = kfs[i].get("volume", 1.0)
        t2 = kfs[i + 1].get("time", 0)
        v2 = kfs[i + 1].get("volume", 1.0)

        dt = t2 - t1
        if dt <= 0:
            continue

        # Linear interp: v1 + (v2-v1) * (t-t1) / (t2-t1)
        slope = (v2 - v1) / dt
        if abs(slope) < 0.001:
            # Constant volume in this range
            expr = f"if(between(t,{t1:.3f},{t2:.3f}),{v1:.3f}"
        else:
            expr = f"if(between(t,{t1:.3f},{t2:.3f}),{v1:.3f}+{slope:.6f}*(t-{t1:.3f})"
        parts.append(expr)

    if not parts:
        return f"volume={kfs[0].get('volume', 1.0)}"

    # Combine with nested else: first match wins
    # ffmpeg eval: if(cond, then, else)
    combined = parts[-1] + f",{kfs[-1].get('volume', 0.0)})"
    for i in range(len(parts) - 2, -1, -1):
        combined = parts[i] + "," + combined + ")"

    return f"volume='{combined}':eval=frame"


# Output video dimensions (segments are scaled/padded to this in the trim step)
_OUT_WIDTH = 1280
_OUT_HEIGHT = 720

# Font size in pixels per style size, tuned for 720p output
_FONT_SIZE_PX = {"small": 28, "medium": 40, "large": 64}


def _find_font_file() -> Optional[str]:
    """Locate a usable TTF/OTF font for drawtext. Returns None to let ffmpeg use its default."""
    candidates = [
        # Linux (Docker image -- Debian/Ubuntu with fonts-dejavu)
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
        # macOS (local dev)
        "/System/Library/Fonts/Supplemental/Arial Bold.ttf",
        "/System/Library/Fonts/Helvetica.ttc",
        "/Library/Fonts/Arial.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            return path
    return None


def _escape_drawtext(text: str) -> str:
    """Escape a string for use in an ffmpeg drawtext `text=` value (single-quoted)."""
    # Order matters: backslash first
    text = text.replace("\\", "\\\\")
    text = text.replace(":", "\\:")
    text = text.replace("'", "\u2019")  # replace apostrophe with typographic to avoid quoting hell
    text = text.replace("%", "\\%")
    # Newlines -> spaces (drawtext single line)
    text = text.replace("\n", " ").replace("\r", " ")
    return text


def _hex_to_ffmpeg_color(color: str) -> str:
    """Normalize a hex color (#rrggbb) to ffmpeg's 0xRRGGBB form. Falls back to white."""
    if not color:
        return "white"
    c = color.strip()
    if c.startswith("#") and len(c) == 7:
        return f"0x{c[1:]}"
    # Named colors pass through (ffmpeg supports many)
    return c


def _build_drawtext_filter(overlay: dict, font_file: Optional[str]) -> Optional[str]:
    """Build a single ffmpeg drawtext filter clause for one text overlay."""
    text = overlay.get("text", "")
    if not text or not str(text).strip():
        return None

    start = float(overlay.get("start_time", 0) or 0)
    end = float(overlay.get("end_time", 0) or 0)
    if end <= start:
        return None

    style = overlay.get("style", {}) or {}
    size = _FONT_SIZE_PX.get(style.get("font_size", "medium"), 40)
    color = _hex_to_ffmpeg_color(style.get("color", "#ffffff"))
    background = style.get("background", "none")
    position = overlay.get("position", "lower")

    # Horizontal: centered
    x_expr = "(w-text_w)/2"

    # Vertical position by placement
    if position == "center":
        y_expr = "(h-text_h)/2"
    elif position == "upper":
        y_expr = "h*0.12"
    else:  # lower
        y_expr = "h*0.82"

    parts = [f"text='{_escape_drawtext(str(text))}'"]
    if font_file:
        # Escape the fontfile path for the filter (colons/spaces handled by quoting the value)
        ff = font_file.replace("\\", "\\\\").replace(":", "\\:")
        parts.append(f"fontfile='{ff}'")
    parts.append(f"fontsize={size}")
    parts.append(f"fontcolor={color}")
    parts.append(f"x={x_expr}")
    parts.append(f"y={y_expr}")

    # Background box for readability
    if background == "solid":
        parts.append("box=1")
        parts.append("boxcolor=black@0.85")
        parts.append("boxborderw=16")
    elif background == "semi":
        parts.append("box=1")
        parts.append("boxcolor=black@0.5")
        parts.append("boxborderw=12")
    else:
        # No box -- add a shadow for legibility over video
        parts.append("shadowcolor=black@0.8")
        parts.append("shadowx=2")
        parts.append("shadowy=2")

    # Timing
    parts.append(f"enable='between(t,{start:.3f},{end:.3f})'")

    return "drawtext=" + ":".join(parts)


def _burn_text_overlays(
    video_file: str,
    text_overlays: list[dict],
    temp_dir: str,
) -> str:
    """Burn text overlays into the video using stacked drawtext filters.

    Applied to the video-only track before audio mux (mux uses -c:v copy).
    Returns the path to the new video, or the original if nothing was burned.
    """
    if not text_overlays:
        return video_file

    font_file = _find_font_file()
    clauses = []
    for overlay in text_overlays:
        clause = _build_drawtext_filter(overlay, font_file)
        if clause:
            clauses.append(clause)

    if not clauses:
        return video_file

    filter_chain = ",".join(clauses)
    output = os.path.join(temp_dir, "with_text.mp4")

    cmd = [
        "ffmpeg", "-y", "-i", video_file,
        "-vf", filter_chain,
        "-c:v", "libx264", "-preset", "ultrafast", "-crf", "26",
        "-pix_fmt", "yuv420p", "-an", output,
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
    if result.returncode != 0:
        # If burning fails, fall back to the un-texted video (don't break export)
        return video_file
    return output


def _build_original_audio(
    timeline: list[dict],
    clip_map: dict[str, str],
    total_duration: float,
    temp_dir: str,
) -> Optional[str]:
    """Extract and combine original audio from timeline segments with volume keyframes."""
    segment_audios = []

    for i, segment in enumerate(timeline):
        src_path = _resolve_clip_path(segment, clip_map)
        if not src_path:
            continue

        start = segment.get("start", 0)
        end = segment.get("end", 0)
        duration = end - start
        if duration <= 0:
            continue

        seg_audio = os.path.join(temp_dir, f"orig_audio_{i:03d}.wav")

        # Extract audio from segment
        cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", src_path, "-t", str(duration),
               "-vn", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", seg_audio]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

        if result.returncode != 0:
            # No audio -- create silence
            cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=44100:cl=stereo",
                   "-t", str(duration), "-acodec", "pcm_s16le", seg_audio]
            subprocess.run(cmd, capture_output=True, text=True, timeout=15)

        # Apply volume keyframes if present
        audio_data = segment.get("audio", {})
        keyframes = audio_data.get("keyframes", []) if isinstance(audio_data, dict) else []
        if keyframes:
            filtered_audio = os.path.join(temp_dir, f"orig_audio_vol_{i:03d}.wav")
            vol_filter = _build_volume_filter(keyframes, duration)
            cmd = ["ffmpeg", "-y", "-i", seg_audio, "-af", vol_filter,
                   "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", filtered_audio]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode == 0:
                seg_audio = filtered_audio

        segment_audios.append(seg_audio)

    if not segment_audios:
        return None

    # Concatenate all segment audios
    concat_list = os.path.join(temp_dir, "orig_audio_concat.txt")
    with open(concat_list, "w") as f:
        for path in segment_audios:
            f.write(f"file '{path}'\n")

    output = os.path.join(temp_dir, "original_audio.wav")
    cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
           "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", output]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    if result.returncode != 0:
        return None
    return output


def _build_speech_track(
    speech_chunks: list[dict],
    total_duration: float,
    temp_dir: str,
) -> Optional[str]:
    """Download speech WAVs and create a combined speech track with correct offsets."""
    if not speech_chunks:
        return None

    # Download speech files
    chunk_files = []
    for chunk in speech_chunks:
        gcs_url = chunk.get("gcs_url")
        if not gcs_url:
            continue

        chunk_id = chunk.get("chunk_id", f"chunk_{len(chunk_files)}")
        local_path = os.path.join(temp_dir, f"speech_{chunk_id}.wav")

        try:
            resp = http_requests.get(gcs_url, timeout=15)
            resp.raise_for_status()
            with open(local_path, "wb") as f:
                f.write(resp.content)
            chunk_files.append({
                "path": local_path,
                "start_time": chunk.get("start_time", 0),
            })
        except Exception:
            continue

    if not chunk_files:
        return None

    # Build a speech track by placing each chunk at its start_time
    # Strategy: create silence of total_duration, then overlay each chunk with adelay
    silence = os.path.join(temp_dir, "speech_silence.wav")
    cmd = ["ffmpeg", "-y", "-f", "lavfi", "-i", f"anullsrc=r=24000:cl=mono",
           "-t", str(total_duration), "-acodec", "pcm_s16le", silence]
    subprocess.run(cmd, capture_output=True, text=True, timeout=15)

    # Overlay chunks one at a time
    current = silence
    for i, cf in enumerate(chunk_files):
        output = os.path.join(temp_dir, f"speech_overlay_{i:03d}.wav")
        delay_ms = int(cf["start_time"] * 1000)

        cmd = [
            "ffmpeg", "-y", "-i", current, "-i", cf["path"],
            "-filter_complex",
            f"[1:a]adelay={delay_ms}|{delay_ms},aresample=44100[delayed];"
            f"[0:a]aresample=44100[base];"
            f"[base][delayed]amix=inputs=2:duration=first:normalize=0[out]",
            "-map", "[out]", "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", output
        ]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            current = output
        # If overlay fails, continue with what we have

    return current if current != silence else None


def _build_music_track(
    music_data: dict,
    total_duration: float,
    temp_dir: str,
) -> Optional[str]:
    """Download music track, trim, and apply volume keyframes."""
    if not music_data:
        return None

    music_url = music_data.get("url") or music_data.get("preview_url")
    if not music_url:
        return None

    # Download music file
    music_file = os.path.join(temp_dir, "music_raw.mp3")
    try:
        resp = http_requests.get(music_url, timeout=30)
        resp.raise_for_status()
        with open(music_file, "wb") as f:
            f.write(resp.content)
    except Exception:
        return None

    # Get placement info
    placement = music_data.get("placement", {})
    track_start = placement.get("track_start", 0)
    end_time = placement.get("end_time", total_duration)
    music_duration = min(end_time, total_duration)

    # Trim and convert to WAV
    trimmed = os.path.join(temp_dir, "music_trimmed.wav")
    cmd = ["ffmpeg", "-y", "-ss", str(track_start), "-i", music_file,
           "-t", str(music_duration),
           "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", trimmed]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
    if result.returncode != 0:
        return None

    # Apply volume keyframes
    keyframes = music_data.get("volume_keyframes", [])
    if keyframes:
        filtered = os.path.join(temp_dir, "music_volume.wav")
        vol_filter = _build_volume_filter(keyframes, music_duration)
        cmd = ["ffmpeg", "-y", "-i", trimmed, "-af", vol_filter,
               "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", filtered]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
        if result.returncode == 0:
            trimmed = filtered

    # If music is shorter than total_duration, pad with silence
    actual_dur = _get_duration(trimmed)
    if actual_dur < total_duration - 0.5:
        padded = os.path.join(temp_dir, "music_padded.wav")
        cmd = ["ffmpeg", "-y", "-i", trimmed, "-af",
               f"apad=whole_dur={total_duration}",
               "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", padded]
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=15)
        if result.returncode == 0:
            trimmed = padded

    return trimmed


def _mix_audio_layers(
    original: Optional[str],
    speech: Optional[str],
    music: Optional[str],
    total_duration: float,
    temp_dir: str,
) -> Optional[str]:
    """Mix available audio layers into a single audio file."""
    inputs = []
    if original:
        inputs.append(original)
    if speech:
        inputs.append(speech)
    if music:
        inputs.append(music)

    if not inputs:
        return None

    if len(inputs) == 1:
        return inputs[0]

    # Mix all layers together
    output = os.path.join(temp_dir, "mixed_audio.wav")
    input_args = []
    for f in inputs:
        input_args.extend(["-i", f])

    filter_str = f"amix=inputs={len(inputs)}:duration=longest:normalize=0"

    cmd = ["ffmpeg", "-y"] + input_args + [
        "-filter_complex", filter_str,
        "-acodec", "pcm_s16le", "-ar", "44100", "-ac", "2", output
    ]
    result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)

    if result.returncode != 0:
        # Fallback: just use the first available track
        return inputs[0]

    return output


def export_proposal(
    proposal: dict[str, Any],
    project_id: str,
    clips_info: list[dict[str, Any]],
    progress_callback: Optional[Any] = None,
) -> str:
    """Render a proposal to MP4 and upload to GCS."""
    temp_dir = tempfile.mkdtemp(prefix=f"export_{project_id}_")

    try:
        # Step 1: Download clips
        clip_map: dict[str, str] = {}
        downloaded: dict[str, str] = {}

        for clip_info in clips_info:
            clip_id = clip_info.get("clip_id", "")
            filename = clip_info.get("filename", "")
            gcs_url = clip_info.get("gcs_url", "")
            file_path = clip_info.get("file_path", "")

            if filename in downloaded:
                local_path = downloaded[filename]
            else:
                local_path = os.path.join(temp_dir, f"{clip_id}_{filename}")

                if file_path.startswith("gcs://"):
                    from app.services.gcs_storage import download_clip as dl_clip
                    gcs_parts = file_path.replace("gcs://", "").split("/", 1)
                    if len(gcs_parts) == 2:
                        content = dl_clip(gcs_parts[0], gcs_parts[1])
                        with open(local_path, "wb") as f:
                            f.write(content)
                elif gcs_url and gcs_url.startswith("https://"):
                    import urllib.request
                    urllib.request.urlretrieve(gcs_url, local_path)
                elif file_path and os.path.exists(file_path):
                    shutil.copy2(file_path, local_path)
                else:
                    continue  # Skip unresolvable clips

                downloaded[filename] = local_path

            # Register under multiple keys
            clip_map[clip_id] = local_path
            clip_map[filename] = local_path
            if file_path:
                clip_map[file_path] = local_path
            name_no_ext = filename.rsplit(".", 1)[0] if "." in filename else filename
            clip_map[name_no_ext] = local_path
            clip_map[f"{clip_id}_{filename}"] = local_path

        timeline = proposal.get("timeline", [])
        if not timeline:
            raise RuntimeError("Proposal has no timeline segments")

        # Step 2: Trim + normalize each segment
        # Use -c copy for speed, then re-encode to uniform format for xfade compatibility
        segment_files = []
        total_segments = len(timeline)

        for i, segment in enumerate(timeline):
            src_path = _resolve_clip_path(segment, clip_map)
            if not src_path:
                raise RuntimeError(
                    f"Cannot find clip for segment {i}: filename={segment.get('filename')}"
                )

            start = segment.get("start", 0)
            end = segment.get("end", 0)
            duration = end - start
            if duration <= 0:
                continue

            filter_str = _get_filter_string(segment)
            seg_output = os.path.join(temp_dir, f"seg_{i:03d}.mp4")

            # Build ffmpeg command -- use ultrafast for speed
            cmd = ["ffmpeg", "-y", "-ss", str(start), "-i", src_path, "-t", str(duration)]

            vf_parts = ["scale=1280:720:force_original_aspect_ratio=decrease", "pad=1280:720:(ow-iw)/2:(oh-ih)/2"]
            if filter_str:
                vf_parts.append(filter_str)

            cmd.extend(["-vf", ",".join(vf_parts)])
            cmd.extend(["-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                        "-r", "30", "-an", "-pix_fmt", "yuv420p", seg_output])

            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode != 0:
                raise RuntimeError(f"ffmpeg trim failed seg {i}: {result.stderr[-300:]}")

            segment_files.append(seg_output)

        if not segment_files:
            raise RuntimeError("No segments rendered")

        # Step 3: Apply transitions
        if len(segment_files) == 1:
            final_output = segment_files[0]
        else:
            final_output = _apply_transitions(segment_files, timeline, temp_dir)

        # Step 3b: Burn text overlays into the video (before audio mux, which uses -c:v copy)
        text_overlays = proposal.get("text_overlays", [])
        if text_overlays:
            final_output = _burn_text_overlays(final_output, text_overlays, temp_dir)

        # Step 4: Build audio layers
        total_duration = proposal.get("total_duration", 0)
        if total_duration <= 0:
            total_duration = sum(s.get("end", 0) - s.get("start", 0) for s in timeline)

        # Original audio (with per-segment volume keyframes)
        original_audio = _build_original_audio(timeline, clip_map, total_duration, temp_dir)

        # Speech audio (voiceover chunks at correct offsets)
        speech_chunks = proposal.get("speech", [])
        speech_audio = _build_speech_track(speech_chunks, total_duration, temp_dir)

        # Music audio (background track with ducking keyframes)
        music_data = proposal.get("music", {})
        music_audio = _build_music_track(music_data, total_duration, temp_dir)

        # Step 5: Mix all audio layers
        mixed_audio = _mix_audio_layers(original_audio, speech_audio, music_audio, total_duration, temp_dir)

        # Step 6: Mux video + audio into final MP4
        if mixed_audio:
            muxed_output = os.path.join(temp_dir, "final_muxed.mp4")
            cmd = [
                "ffmpeg", "-y",
                "-i", final_output, "-i", mixed_audio,
                "-c:v", "copy", "-c:a", "aac", "-b:a", "192k",
                "-shortest", muxed_output
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
            if result.returncode == 0:
                final_output = muxed_output

        # Step 7: Upload to GCS
        export_id = str(uuid.uuid4())
        with open(final_output, "rb") as f:
            content = f.read()

        gcs_url = upload_to_gcs(
            content, project_id, f"exports/export_{export_id}.mp4", content_type="video/mp4"
        )
        return gcs_url

    finally:
        shutil.rmtree(temp_dir, ignore_errors=True)


def _apply_transitions(
    segment_files: list[str],
    timeline: list[dict],
    temp_dir: str,
) -> str:
    """Apply xfade transitions between segments iteratively."""
    current_file = segment_files[0]

    for i in range(1, len(segment_files)):
        next_file = segment_files[i]
        segment = timeline[i]

        transition = segment.get("transition", "cut")
        if isinstance(transition, dict):
            t_type = transition.get("type", "cut")
            t_duration = transition.get("duration", 0)
        else:
            t_type = str(transition)
            t_duration = 0

        output_file = os.path.join(temp_dir, f"merged_{i:03d}.mp4")

        if t_type == "cut" or t_duration <= 0:
            # Simple concat
            concat_list = os.path.join(temp_dir, f"concat_{i}.txt")
            with open(concat_list, "w") as f:
                f.write(f"file '{current_file}'\n")
                f.write(f"file '{next_file}'\n")

            cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
                   "-c", "copy", output_file]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            if result.returncode != 0:
                # Fallback: re-encode concat
                cmd = ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
                       "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28", "-pix_fmt", "yuv420p", output_file]
                subprocess.run(cmd, capture_output=True, text=True, timeout=60)
        else:
            # xfade transition
            xfade_name = _get_xfade_name(t_type)
            current_duration = _get_duration(current_file)
            offset = max(0, current_duration - t_duration)

            cmd = [
                "ffmpeg", "-y", "-i", current_file, "-i", next_file,
                "-filter_complex",
                f"[0:v][1:v]xfade=transition={xfade_name}:duration={t_duration:.2f}:offset={offset:.2f}[v]",
                "-map", "[v]", "-c:v", "libx264", "-preset", "ultrafast", "-crf", "28",
                "-pix_fmt", "yuv420p", output_file
            ]
            result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

            if result.returncode != 0:
                # Fallback to simple concat
                concat_list = os.path.join(temp_dir, f"concat_fb_{i}.txt")
                with open(concat_list, "w") as f:
                    f.write(f"file '{current_file}'\n")
                    f.write(f"file '{next_file}'\n")
                subprocess.run(
                    ["ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", concat_list,
                     "-c", "copy", output_file],
                    capture_output=True, text=True, timeout=30
                )

        current_file = output_file

    return current_file
