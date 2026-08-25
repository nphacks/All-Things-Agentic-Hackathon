"""Agent execution service.

Runs the ADK agent as a background task, watches the event stream,
and updates Firestore with progress at each step.

Supports both local file paths and GCS URLs for clip access.
For GCS clips, downloads to a temp directory before passing to the agent.
"""

import json
import logging
import os
import tempfile
from pathlib import Path
from typing import Optional

from google.adk.runners import InMemoryRunner
from google.genai.types import Content, Part

from app.agent.editor_agent import ad_cut_agent
from app.agent.tools import set_proposal_limit
from app.config import settings
from app.services.firestore import (
    sanitize_for_firestore,
    store_clip_analysis,
    store_clip_audio_analysis,
    store_clip_waveform,
    store_edit_log,
    store_music_data,
    store_proposals,
    store_speech_data,
    update_job_status,
)
from app.services.gcs_storage import download_clip
from app.services.speech_renderer import render_speech_chunks
from app.services.waveform import extract_waveform

logger = logging.getLogger("agent_runner")
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(levelname)s: %(message)s")


def _disable_adk_tracing():
    """Neutralize ADK's LLM request tracing.

    ADK's telemetry.trace_call_llm() calls json.dumps() on the full LLM
    request. When the request carries binary video data (which ours does
    via Part.from_bytes for clip analysis), that serialization raises
    "Object of type bytes is not JSON serializable" and crashes the run.

    We don't use OpenTelemetry, so these trace calls are pure overhead.
    Patch them to no-ops. Idempotent -- safe to call multiple times.
    """
    try:
        from google.adk import telemetry as _adk_telemetry

        def _noop(*args, **kwargs):
            return None

        _adk_telemetry.trace_call_llm = _noop
        _adk_telemetry.trace_send_data = _noop

        # Also patch the copies already imported into the flow modules
        try:
            from google.adk.flows.llm_flows import base_llm_flow as _bf
            if hasattr(_bf, "trace_call_llm"):
                _bf.trace_call_llm = _noop
            if hasattr(_bf, "trace_send_data"):
                _bf.trace_send_data = _noop
        except Exception:
            pass
    except Exception:
        # If ADK internals change, don't block the run over tracing
        pass


def _ensure_adk_env():
    """Set environment variables needed by ADK for Vertex AI."""
    os.environ.setdefault("GOOGLE_GENAI_USE_VERTEXAI", "1")
    os.environ.setdefault("GOOGLE_CLOUD_PROJECT", settings.google_cloud_project)
    os.environ.setdefault("GOOGLE_CLOUD_LOCATION", "global")

    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    _disable_adk_tracing()


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

    manage_audio = settings_dict.get("manage_audio", True)
    audio_text = ""
    if manage_audio:
        audio_text = "Original audio control: ENABLED -- when calling generate_edit_plan, set manage_audio=True. Include audio volume keyframes per segment based on audio analysis (audio_quality, audio_type, overall_volume). Control original audio to balance segments and handle bad audio."
    else:
        audio_text = "Original audio control: DISABLED -- when calling generate_edit_plan, set manage_audio=False. All segments will play at full original volume."

    add_voiceover = settings_dict.get("add_voiceover", False)
    voice_name = settings_dict.get("voice_name", "en-US-Journey-D")
    speaking_rate = settings_dict.get("speaking_rate", 1.0)
    speech_context = settings_dict.get("speech_context", "")
    voiceover_text = ""
    if add_voiceover:
        voiceover_text = (
            f"Voiceover: ENABLED -- after generating all proposals, call generate_speech_script for EACH proposal. "
            f"Pass the clip analyses, the proposal timeline JSON, the brief, voice_name=\"{voice_name}\", "
            f"and speaking_rate={speaking_rate}. Generate a voiceover script aligned to each proposal's timeline."
        )
        if speech_context.strip():
            voiceover_text += (
                f"\nSpeech context (pass as speech_context parameter): \"{speech_context}\""
            )
    else:
        voiceover_text = "Voiceover: DISABLED -- do NOT call generate_speech_script."

    add_background_music = settings_dict.get("add_background_music", True)
    music_text = ""
    if add_background_music:
        music_text = (
            "Background Music: ENABLED -- after generating proposals (and speech scripts if voiceover is enabled), "
            "call select_background_music for EACH proposal. Derive mood_keywords from the clip analyses and brief "
            "(e.g., 'calm, acoustic, travel' for a calm travel video). Pass the brief, mood_keywords, the proposal's "
            "total_duration as timeline_duration, and speech_chunks_json (the JSON array of speech chunks for that "
            "proposal, or '[]' if no voiceover)."
        )
    else:
        music_text = "Background Music: DISABLED -- do NOT call select_background_music."

    return f"""I need you to create ad proposals for me.

Creative brief: {brief}
Duration constraints: min {min_duration} seconds, max {max_duration} seconds
Number of proposals: {num_proposals}
{variation_text}
{transitions_text}
{filters_text}
{brightness_text}
{audio_text}
{voiceover_text}
{music_text}

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

    logger.info(f"[Job {job_id}] Starting -- {num_clips} clips, {num_proposals} proposals requested")

    try:
        # Update status to analyzing
        update_job_status(job_id, "analyzing", progress=f"Starting analysis of {num_clips} clips...")

        # Download GCS clips to temp directory if needed
        temp_dir = tempfile.mkdtemp(prefix=f"job_{job_id}_")
        clip_paths = []
        for clip_info in clip_info_list:
            local_path = _resolve_clip_path(clip_info, temp_dir)
            clip_paths.append(local_path)

        # Extract waveform data for each clip (fast local ffmpeg operation)
        # Done before agent starts but stored after agent completes to avoid overwrites
        waveform_data = {}
        for idx, local_path in enumerate(clip_paths):
            clip_id = f"clip_{idx + 1}"
            waveform = extract_waveform(local_path, num_points=150)
            waveform_data[clip_id] = waveform

        # Create runner and session
        set_proposal_limit(num_proposals)
        logger.info(f"[Job {job_id}] Proposal limit set to {num_proposals}")
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
        audio_analyzed = 0
        proposals_generated = 0
        speech_scripts_generated = 0
        music_selections = 0
        clip_analyses = {}
        proposals = []
        speech_scripts = []  # list of speech chunk arrays, one per proposal
        music_data = []  # list of music selection dicts, one per proposal
        edit_log = []  # AI edit log entries
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

                    # Sanitize immediately so no bytes propagate downstream
                    response_data = sanitize_for_firestore(response_data)

                    status = response_data.get("status", "")

                    # Track analyze_clip completions
                    if fr.name == "analyze_clip" and status == "success":
                        clips_analyzed += 1
                        clip_id = f"clip_{clips_analyzed}"
                        store_clip_analysis(job_id, clip_id, response_data)
                        clip_analyses[clip_id] = response_data

                        # Edit log entry
                        mood = response_data.get("overall_mood", "unknown mood")
                        best = response_data.get("best_moments", [])
                        best_summary = best[0].get("why", "") if best else ""
                        edit_log.append({
                            "action": "analyzed_clip",
                            "clip": response_data.get("file_path", f"clip_{clips_analyzed}"),
                            "summary": f"{mood}. {best_summary}".strip(),
                        })

                        logger.info(f"[Job {job_id}] Clip analyzed ({clips_analyzed}/{num_clips}): {mood}")

                        update_job_status(
                            job_id, "analyzing",
                            progress=f"Analyzed {clips_analyzed} of {num_clips} clips (video), {audio_analyzed} of {num_clips} (audio)"
                        )

                    # Track analyze_clip_audio completions
                    elif fr.name == "analyze_clip_audio" and status == "success":
                        audio_analyzed += 1
                        # Associate with the clip by matching file_path
                        audio_clip_id = f"clip_{audio_analyzed}"
                        # Try to find matching clip_id by file_path
                        audio_file_path = response_data.get("file_path", "")
                        for cid, cdata in clip_analyses.items():
                            if cdata.get("file_path") == audio_file_path:
                                audio_clip_id = cid
                                break
                        store_clip_audio_analysis(job_id, audio_clip_id, response_data)

                        # Edit log entry
                        audio_type = response_data.get("audio_type", "unknown")
                        quality = response_data.get("audio_quality", "unknown")
                        edit_log.append({
                            "action": "analyzed_audio",
                            "clip": audio_file_path or audio_clip_id,
                            "summary": f"Audio: {audio_type}, quality: {quality}",
                        })

                        logger.info(f"[Job {job_id}] Audio analyzed ({audio_analyzed}/{num_clips}): {audio_type}, {quality}")

                        update_job_status(
                            job_id, "analyzing",
                            progress=f"Analyzed {clips_analyzed} of {num_clips} clips (video), {audio_analyzed} of {num_clips} (audio)"
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

                        # Cap at requested number of proposals
                        if len(proposals) < num_proposals:
                            proposals.append(response_data)
                            logger.info(f"[Job {job_id}] Proposal generated ({len(proposals)}/{num_proposals}): {response_data.get('label', '?')}")
                        else:
                            logger.warning(f"[Job {job_id}] Extra proposal ignored (already have {num_proposals})")

                        # Edit log entries for proposal decisions
                        label = response_data.get("label", f"Proposal {proposals_generated}")
                        timeline = response_data.get("timeline", [])
                        not_used = response_data.get("clips_not_used", [])
                        not_used_reason = response_data.get("clips_not_used_reason", "")
                        edit_log.append({
                            "action": "generated_proposal",
                            "summary": f"{label}: {len(timeline)} segments, {response_data.get('total_duration', 0):.1f}s",
                        })
                        if not_used:
                            edit_log.append({
                                "action": "skipped_clips",
                                "clips": not_used,
                                "reason": not_used_reason,
                            })
                        # Log transition choices
                        transitions_used = set()
                        for seg in timeline:
                            t = seg.get("transition", "cut")
                            if isinstance(t, dict):
                                transitions_used.add(t.get("type", "cut"))
                            elif isinstance(t, str):
                                transitions_used.add(t)
                        non_cut = [t for t in transitions_used if t != "cut"]
                        if non_cut:
                            edit_log.append({
                                "action": "placed_transitions",
                                "summary": f"Transitions used: {', '.join(non_cut)}",
                            })

                        update_job_status(
                            job_id, "generating",
                            progress=f"Generated proposal {min(proposals_generated, num_proposals)} of {num_proposals}"
                        )

                    # Track generate_speech_script completions
                    elif fr.name == "generate_speech_script" and status == "success":
                        speech_scripts_generated += 1
                        speech_chunks = response_data.get("speech", [])
                        speech_scripts.append(speech_chunks)

                        # Edit log entry
                        edit_log.append({
                            "action": "generated_speech",
                            "summary": f"{len(speech_chunks)} chunks for proposal {speech_scripts_generated}",
                        })

                        logger.info(f"[Job {job_id}] Speech script generated ({speech_scripts_generated}): {len(speech_chunks)} chunks")

                        update_job_status(
                            job_id, "generating",
                            progress=f"Generated speech script {speech_scripts_generated} of {num_proposals}"
                        )

                    # Track select_background_music completions
                    elif fr.name == "select_background_music" and status == "success":
                        music_selections += 1
                        music_result = response_data.get("music", {})
                        music_data.append(music_result)

                        # Edit log entry
                        edit_log.append({
                            "action": "selected_music",
                            "track": music_result.get("title", "Unknown"),
                            "artist": music_result.get("artist", ""),
                            "reason": music_result.get("reason", ""),
                        })

                        logger.info(f"[Job {job_id}] Music selected ({music_selections}): {music_result.get('title', '?')} by {music_result.get('artist', '?')}")

                        update_job_status(
                            job_id, "generating",
                            progress=f"Selected background music {music_selections} of {num_proposals}"
                        )

                    # Log tool errors
                    elif status == "error":
                        msg = response_data.get("message", "unknown error")
                        logger.warning(f"[Job {job_id}] Tool {fr.name} returned error: {msg}")

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
                    text=f"You have analyzed all {clips_analyzed} clips (video + audio). Now please generate "
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

                        # Sanitize immediately so no bytes propagate downstream
                        response_data = sanitize_for_firestore(response_data)

                        if fr.name == "generate_edit_plan" and response_data.get("status") == "success":
                            if not switched_to_generating:
                                switched_to_generating = True
                            proposals_generated += 1

                            # Cap at requested number of proposals
                            if len(proposals) < num_proposals:
                                proposals.append(response_data)

                            update_job_status(
                                job_id, "generating",
                                progress=f"Generated proposal {min(proposals_generated, num_proposals)} of {num_proposals}"
                            )

                        # Also handle any late audio analyses in the follow-up
                        elif fr.name == "analyze_clip_audio" and response_data.get("status") == "success":
                            audio_analyzed += 1
                            audio_clip_id = f"clip_{audio_analyzed}"
                            audio_file_path = response_data.get("file_path", "")
                            for cid, cdata in clip_analyses.items():
                                if cdata.get("file_path") == audio_file_path:
                                    audio_clip_id = cid
                                    break
                            store_clip_audio_analysis(job_id, audio_clip_id, response_data)

                        # Track speech scripts in follow-up
                        elif fr.name == "generate_speech_script" and response_data.get("status") == "success":
                            speech_scripts_generated += 1
                            speech_chunks = response_data.get("speech", [])
                            speech_scripts.append(speech_chunks)

                        # Track music selections in follow-up
                        elif fr.name == "select_background_music" and response_data.get("status") == "success":
                            music_selections += 1
                            music_result = response_data.get("music", {})
                            music_data.append(music_result)

        # Store final proposals and mark complete
        if proposals:
            try:
                store_proposals(job_id, proposals)
            except Exception as e:
                logger.error(f"[Job {job_id}] Failed to store proposals: {e}")

        # Store waveform data (after analyses stored so it doesn't get overwritten)
        for clip_id, waveform in waveform_data.items():
            try:
                store_clip_waveform(job_id, clip_id, waveform)
            except Exception as e:
                logger.warning(f"[Job {job_id}] Failed to store waveform {clip_id}: {e}")

        # Render speech chunks if voiceover was enabled and scripts were generated
        add_voiceover = settings_dict.get("add_voiceover", False)
        voice_name = settings_dict.get("voice_name", "en-US-Journey-D")
        project_id = settings_dict.get("project_id", job_id)

        if add_voiceover and speech_scripts:
            update_job_status(
                job_id, "generating",
                progress=f"Rendering {len(speech_scripts)} speech scripts..."
            )

            for idx, chunks in enumerate(speech_scripts):
                if not chunks:
                    continue

                # Namespace chunk IDs per proposal so GCS paths don't collide.
                # The agent reuses sp_01, sp_02... across proposals, which would
                # otherwise overwrite each other's audio in GCS.
                for chunk in chunks:
                    base_id = chunk.get("chunk_id", "sp")
                    if not base_id.startswith(f"p{idx}_"):
                        chunk["chunk_id"] = f"p{idx}_{base_id}"

                update_job_status(
                    job_id, "generating",
                    progress=f"Rendering speech for proposal {idx + 1} of {len(speech_scripts)}..."
                )

                rendered_chunks = await render_speech_chunks(
                    chunks=chunks,
                    project_id=project_id,
                    voice_name=voice_name,
                )

                # Store rendered speech data in Firestore
                try:
                    store_speech_data(job_id, idx, sanitize_for_firestore(rendered_chunks))
                except Exception as e:
                    logger.warning(f"[Job {job_id}] Failed to store speech for proposal {idx}: {e}")

        # Store music data in Firestore per proposal
        if music_data:
            for idx, music in enumerate(music_data):
                if music and idx < len(proposals):
                    try:
                        store_music_data(job_id, idx, music)
                    except Exception as e:
                        logger.warning(f"[Job {job_id}] Failed to store music for proposal {idx}: {e}")

        # Store edit log
        if edit_log:
            try:
                store_edit_log(job_id, edit_log)
            except Exception as e:
                logger.warning(f"[Job {job_id}] Failed to store edit log: {e}")

        logger.info(f"[Job {job_id}] Completed -- {clips_analyzed} clips, {len(proposals)} proposals, {len(speech_scripts)} speech scripts, {len(music_data)} music selections")

        update_job_status(
            job_id, "completed",
            progress=f"Done -- {clips_analyzed} clips analyzed, {len(proposals)} proposals generated"
        )

    except Exception as e:
        import traceback
        logger.error(f"[Job {job_id}] Error during run: {e}\n{traceback.format_exc()}")
        # If we managed to produce and store proposals before the error,
        # complete the job with a warning instead of failing entirely.
        if proposals:
            logger.info(f"[Job {job_id}] Completing with {len(proposals)} proposals despite error")
            try:
                store_proposals(job_id, proposals)
            except Exception:
                pass
            update_job_status(
                job_id, "completed",
                progress=f"Completed with {len(proposals)} proposals (some steps encountered issues)"
            )
        else:
            update_job_status(job_id, "failed", error=str(e), progress="Failed")
    finally:
        # Clean up temp files
        import shutil
        if temp_dir and os.path.exists(temp_dir):
            shutil.rmtree(temp_dir, ignore_errors=True)
