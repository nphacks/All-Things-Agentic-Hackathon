"""Video export service using ffmpeg.

Renders a proposal into a single MP4 file.
Strategy:
1. Download clips from GCS
2. Trim segments with -c copy (fast, no re-encode)
3. Re-encode trimmed segments to normalize format (needed for xfade compatibility)
4. Apply xfade transitions iteratively between segments
5. Upload final to GCS
"""

import os
import shutil
import subprocess
import tempfile
import uuid
from pathlib import Path
from typing import Any, Optional

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

        # Step 4: Upload to GCS
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
