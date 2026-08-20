"""Agent execution service.

Runs the ADK agent as a background task, watches the event stream,
and updates Firestore with progress at each step.

Supports both local file paths and GCS URLs for clip access.
For GCS clips, downloads to a temp directory before passing to the agent.
"""

import json
import os
import tempfile
from pathlib import Path
from typing import Optional

from google.adk.runners import InMemoryRunner
from google.genai.types import Content, Part

from app.agent.editor_agent import ad_cut_agent
from app.config import settings
from app.services.firestore import (
    store_clip_analysis,
    store_proposals,
    update_job_status,
)
from app.services.gcs_storage import download_clip


def _ensure_adk_env():
    """Set environment variables needed by ADK for Vertex AI."""
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.google_cloud_project)
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "us-central1")

    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved


def _resolve_clip_path(clip_info: dict, temp_dir: str) -> str:
    """Resolve a clip to a local file path.

    If the clip has a GCS URL, downloads it to the temp directory.
    If it's a local path, returns it directly.
    """
    gcs_url = clip_info.get("gcs_url")
    file_path = clip_info.get("file_path", "")
    filename = clip_info.get("filename", "clip.mp4")

    # GCS-stored clip: download to temp
    if gcs_url and file_path.startswith("gcs://"):
        # Parse project_id and storage_filename from file_path: gcs://{project_id}/{filename}
        gcs_parts = file_path.replace("gcs://", "").split("/", 1)
        if len(gcs_parts) == 2:
            project_id, storage_filename = gcs_parts
            content = download_clip(project_id, storage_filename)
            local_path = os.path.join(temp_dir, storage_filename)
            with open(local_path, "wb") as f:
                f.write(content)
            return local_path

    # Legacy local file path
    if os.path.exists(file_path):
        return file_path

    # Fallback: try as-is
    return file_path


def _build_user_message(brief: str, clip_paths: list[str], settings_dict: dict) -> str:
    """Build the user message that tells the agent what to do."""
    num_proposals = settings_dict.get("num_proposals", 3)
    min_duration = settings_dict.get("min_duration", 20)
    max_duration = settings_dict.get("max_duration", 30)
    variations = settings_dict.get("variations", [])
    add_transitions = settings_dict.get("add_transitions", True)
    allow_filters = settings_dict.get("allow_filters", True)

    clip_list = "\n".join(f"- {path}" for path in clip_paths)

    variation_text = ""
    if variations:
        variation_text = f"Variation preferences: {', '.join(variations)}"
    else:
        variation_text = "Variation preferences: make each proposal distinctly different (vary pacing, mood, clip selection)"

    transitions_text = ""
    if add_transitions:
        transitions_text = "Transitions: ENABLED -- when calling generate_edit_plan, set add_transitions=True so proposals include transition effects (crossfade, fade_to_black, wipe, etc.) between segments."
    else:
        transitions_text = "Transitions: DISABLED -- when calling generate_edit_plan, set add_transitions=False. All transitions should be simple cuts."

    filters_text = ""
    if allow_filters:
        filters_text = "Filters: ENABLED -- when calling generate_edit_plan, set allow_filters=True. You may apply visual filters (grayscale, sepia, warm, cool, etc.) to individual segments when it enhances the mood. Not required on every segment."
    else:
        filters_text = "Filters: DISABLED -- when calling generate_edit_plan, set allow_filters=False. No visual filters should be applied."

    auto_brightness = settings_dict.get("auto_brightness", True)
    brightness_text = ""
    if auto_brightness:
        brightness_text = "Brightness correction: ENABLED -- when calling generate_edit_plan, set auto_brightness=True. Analyze brightness_level from clip analyses and apply brightness_adjustment (0.8-1.2) to smooth large brightness jumps between adjacent segments."
    else:
        brightness_text = "Brightness correction: DISABLED -- when calling generate_edit_plan, set auto_brightness=False."

    return f"""I need you to create ad proposals for me.

Creative brief: {brief}
Duration constraints: min {min_duration} seconds, max {max_duration} seconds
Number of proposals: {num_proposals}
{variation_text}
{transitions_text}
{filters_text}
{brightness_text}

Clip file paths to analyze:
{clip_list}

Please analyze all clips and then generate {num_proposals} distinct proposals."""


async def run_agent_job(
    job_id: str,
    clip_info_list: list[dict],
    brief: str,
    settings_dict: dict,
):
    """Run the ADK agent for a job, tracking progress in Firestore.

    This is the background task that gets kicked off by POST /jobs/create.
    It watches the agent's event stream and updates Firestore at each step.

    Args:
        job_id: Unique job identifier.
        clip_info_list: List of dicts with file_path, gcs_url, filename for each clip.
        brief: Creative brief text.
        settings_dict: Job settings (duration, proposals count, variations).
    """
    _ensure_adk_env()

    num_clips = len(clip_info_list)
    num_proposals = settings_dict.get("num_proposals", 3)

    try:
        # Update status to analyzing
        update_job_status(job_id, "analyzing", progress=f"Starting analysis of {num_clips} clips...")

        # Download GCS clips to temp directory if needed
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        clip_paths = []
        for clip_info in clip_info_list:
            local_path = _resolve_clip_path(clip_info, temp_dir)
            clip_paths.append(local_path)

        # Create runner and session
        runner = InMemoryRunner(
            agent=ad_cut_agent,
            app_name=f"job_{job_id}",
        )

        session = runner.session_service.create_session(
            app_name=f"job_{job_id}",
            user_id="system",
        )

        # Build user message
        message_text = _build_user_message(brief, clip_paths, settings_dict)
        user_content = Content(
            role="user",
            parts=[Part.from_text(text=message_text)],
        )

        # Track progress
        clips_analyzed = 0
        proposals_generated = 0
        clip_analyses = {}
        proposals = []
        switched_to_generating = False
        final_text = ""

        # Run agent and watch events
        async for event in runner.run_async(
            user_id="system",
            session_id=session.id,
            new_message=user_content,
        ):
            if not event.content or not event.content.parts:
                continue

            for part in event.content.parts:
                # Watch for function responses (tool results)
                if hasattr(part, "function_response") and part.function_response:
                    fr = part.function_response
                    response_data = fr.response if hasattr(fr, "response") else {}

                    if not isinstance(response_data, dict):
                        continue

                    status = response_data.get("status", "")

                    # Track analyze_clip completions
                    if fr.name == "analyze_clip" and status == "success":
                        clips_analyzed += 1
                        clip_id = f"clip_{clips_analyzed}"
                        store_clip_analysis(job_id, clip_id, response_data)
                        clip_analyses[clip_id] = response_data

                        update_job_status(
                            job_id, "analyzing",
                            progress=f"Analyzed {clips_analyzed} of {num_clips} clips"
                        )

                    # Track generate_edit_plan completions
                    elif fr.name == "generate_edit_plan" and status == "success":
                        if not switched_to_generating:
                            switched_to_generating = True
                            update_job_status(
                                job_id, "generating",
                                progress=f"Generating proposal 1 of {num_proposals}..."
                            )

                        proposals_generated += 1
                        proposals.append(response_data)

                        update_job_status(
                            job_id, "generating",
                            progress=f"Generated proposal {proposals_generated} of {num_proposals}"
                        )

                # Capture final text response
                if hasattr(part, "text") and part.text:
                    final_text += part.text

        # If agent analyzed clips but didn't generate proposals, send a follow-up
        if clips_analyzed > 0 and proposals_generated == 0:
            update_job_status(
                job_id, "generating",
                progress="Analysis complete, prompting for proposals..."
            )

            followup = Content(
                role="user",
                parts=[Part.from_text(
                    text=f"You have analyzed all {clips_analyzed} clips. Now please generate "
                         f"{num_proposals} distinct proposals by calling generate_edit_plan "
                         f"{num_proposals} times, each with a different creative direction."
                )],
            )

            async for event in runner.run_async(
                user_id="system",
                session_id=session.id,
                new_message=followup,
            ):
                if not event.content or not event.content.parts:
                    continue

                for part in event.content.parts:
                    if hasattr(part, "function_response") and part.function_response:
                        fr = part.function_response
                        response_data = fr.response if hasattr(fr, "response") else {}

                        if not isinstance(response_data, dict):
                            continue

                        if fr.name == "generate_edit_plan" and response_data.get("status") == "success":
                            if not switched_to_generating:
                                switched_to_generating = True
                            proposals_generated += 1
                            proposals.append(response_data)

                            update_job_status(
                                job_id, "generating",
                                progress=f"Generated proposal {proposals_generated} of {num_proposals}"
                            )

        # Store final proposals and mark complete
        if proposals:
            store_proposals(job_id, proposals)

        update_job_status(
            job_id, "completed",
            progress=f"Done -- {clips_analyzed} clips analyzed, {proposals_generated} proposals generated"
        )

    except Exception as e:
        update_job_status(job_id, "failed", error=str(e), progress="Failed")
    finally:
        # Clean up temp files
        import shutil
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
