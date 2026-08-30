"""ADK agent tools for video analysis and edit plan generation.

These are designed as ADK-compatible function tools:
- Clear, descriptive names and docstrings (LLM reads these)
- Type-annotated parameters with simple types
- Return dicts with status keys
- Handle errors gracefully (return error info, don't raise)
"""

import json
import os
import threading
from pathlib import Path

from google import genai
from google.genai.types import Part

from app.config import settings


# Maximum video file size we'll send to Gemini (200MB)
MAX_VIDEO_SIZE_BYTES = 200 * 1024 * 1024

# Proposal generation limiter -- prevents the agent from generating more proposals than requested.
# Set before each job run via set_proposal_limit(), checked inside generate_edit_plan().
_proposal_lock = threading.Lock()
_proposal_count = 0
_proposal_limit = 3  # default


def set_proposal_limit(limit: int) -> None:
    """Set the max proposals allowed and reset the counter. Call before each job."""
    global _proposal_count, _proposal_limit
    with _proposal_lock:
        _proposal_count = 0
        _proposal_limit = limit


def _check_proposal_limit() -> bool:
    """Check if within limit without incrementing. Returns True if allowed."""
    with _proposal_lock:
        return _proposal_count < _proposal_limit


def _increment_proposal_count() -> None:
    """Increment the proposal counter after a successful generation."""
    global _proposal_count
    with _proposal_lock:
        _proposal_count += 1


ANALYZE_CLIP_PROMPT = """Analyze this video clip for use in a video advertisement. Return ONLY valid JSON (no markdown, no code fences).

Use this exact schema:
{{
  "duration_seconds": <number>,
  "segments": [
    {{
      "start": <seconds>,
      "end": <seconds>,
      "description": "What happens visually in this segment",
      "mood": "Emotional tone (e.g., majestic, calm, energetic, warm)",
      "energy": "low|medium|high",
      "visual_quality": "low|medium|high",
      "usability": "How this segment could be used in an ad (e.g., strong opener, transition, product shot, filler)"
    }}
  ],
  "overall_mood": "Dominant mood of the entire clip",
  "best_moments": [
    {{"time": <seconds>, "why": "Why this moment stands out visually or emotionally"}}
  ],
  "has_text": <boolean>,
  "has_faces": <boolean>,
  "perceived_speed": "timelapse|fast_motion|normal|slow_motion|static",
  "motion_intensity": <integer 1-10>,
  "brightness_level": "dark|medium|bright",
  "has_internal_cuts": <boolean>
}}

Rules:
- Segments must cover the full clip duration with no gaps
- end of one segment equals start of the next
- energy and visual_quality must be exactly: "low", "medium", or "high"
- best_moments should highlight 1-3 peak visual or emotional moments
- has_text: true if any text, signs, or writing is visible
- has_faces: true if any human faces are clearly visible
- perceived_speed: how fast the footage appears to be playing
  - "timelapse" = heavily sped up (clouds, traffic, etc.)
  - "fast_motion" = noticeably faster than real-time
  - "normal" = real-time footage
  - "slow_motion" = noticeably slowed down
  - "static" = nearly no motion (still frame, tripod shot with no movement)
- motion_intensity: 1 = almost no movement in frame, 10 = extreme camera/subject movement
- brightness_level: overall brightness of the clip ("dark" = nighttime/underexposed, "medium" = normal daylight, "bright" = overexposed/very bright)
- has_internal_cuts: true if the clip contains visible edits or cuts within it (scene changes, jump cuts)
- Return ONLY valid JSON, nothing else

{additional_focus}"""


ANALYZE_CLIP_AUDIO_PROMPT = """Analyze the AUDIO in this video clip. Focus entirely on what you can HEAR, not what you see. Return ONLY valid JSON (no markdown, no code fences).

Use this exact schema:
{{
  "has_audio": <boolean - true if any audio is present, false if completely silent>,
  "audio_type": "dialogue|music|ambient|narration|mixed|silence",
  "overall_volume": "quiet|medium|loud",
  "audio_quality": "clean|noisy|windy|echo",
  "speech_content": "<brief transcript if speech/dialogue/narration is present, null otherwise>",
  "audio_moments": [
    {{"time": <seconds>, "event": "description of audio event", "volume_spike": <boolean>}}
  ],
  "volume_profile": "consistent|dynamic|fades_out|builds_up"
}}

Rules:
- has_audio: false only if the clip is completely silent (no sound at all)
- audio_type:
  - "dialogue" = people talking/conversing
  - "music" = background music or musical performance
  - "ambient" = environmental sounds (waves, traffic, birds, wind, crowd noise)
  - "narration" = voiceover or single speaker narrating
  - "mixed" = combination of multiple types (e.g., music + ambient, dialogue + music)
  - "silence" = no discernible audio content
- overall_volume: perceived loudness of the audio track
- audio_quality:
  - "clean" = clear, well-recorded audio
  - "noisy" = background noise, hiss, or interference
  - "windy" = wind noise on microphone
  - "echo" = reverberant, echoey space
- speech_content: if there is speech, provide a brief transcript (1-3 sentences max). If no speech, set to null.
- audio_moments: list 1-5 notable audio events (sound effects, volume changes, beats, speech starts). Include timestamp and whether it represents a volume spike.
- volume_profile:
  - "consistent" = audio level stays roughly the same throughout
  - "dynamic" = volume varies significantly (loud and quiet parts)
  - "fades_out" = audio gets quieter toward the end
  - "builds_up" = audio gets louder toward the end
- If has_audio is false, set audio_type to "silence", overall_volume to "quiet", audio_quality to "clean", speech_content to null, audio_moments to empty array, volume_profile to "consistent"
- Return ONLY valid JSON, nothing else

{additional_focus}"""


GENERATE_EDIT_PLAN_PROMPT = """You are an experienced video editor. You have analyzed a set of raw video clips and now need to assemble one timeline proposal for an advertisement.

## Creative Brief
{brief}

## Duration Constraints
- Minimum duration: {min_duration} seconds
- Maximum duration: {max_duration} seconds
The total timeline MUST fall within these constraints.

## Creative Direction
{variation_instruction}

## Available Clip Analyses
{clip_analyses_json}
{transitions_section}
{filters_section}
{brightness_section}
{audio_section}
## Your Task
Create ONE timeline proposal that satisfies the brief and creative direction. Think like an experienced editor:
- Consider pacing, narrative arc, visual flow, and emotional impact
- Prefer to use variety across the available clips. Intercutting between multiple clips almost always makes a stronger, more dynamic edit than relying on a single clip -- this is especially true for short ads and montages, where cutting between different shots creates energy. Aim to draw from most or all of the available footage.
- You MAY still choose NOT to use a clip, but only if it genuinely conflicts with the brief (wrong subject, poor quality, clashing mood). Do not skip a usable clip just because one other clip could fill the time on its own.
- Select the best segments from each clip (you don't have to use the full clip)
- You MAY use multiple non-contiguous segments from the same clip. For example, use seconds 1-3 and seconds 7-10 from the same source file as separate timeline entries. This is useful when a clip has a strong opening and ending but a weak middle, or when you want to revisit a clip for emphasis.
- Ensure smooth transitions between segments

Return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{{
  "label": "Short descriptive name for this edit approach",
  "reasoning": "2-3 sentences explaining your editorial choices",
  "total_duration": <number - total seconds of the assembled timeline>,
  "timeline": [
    {{
      "clip_id": "<file_path from the clip analysis>",
      "filename": "<filename portion of the file_path>",
      "start": <start second within the original clip>,
      "end": <end second within the original clip>,
      "position_in_timeline": <start position in the assembled timeline>,
      "transition": {transition_schema}{filter_field}{brightness_field}{audio_field}
    }}
  ],
  "clips_not_used": ["<file_path>", ...],
  "clips_not_used_reason": "Brief explanation of why these clips were excluded"
}}

Rules:
- IMPORTANT: Use the exact file_path from each clip analysis as the clip_id value
- The same clip_id MAY appear multiple times in the timeline with different start/end values (non-contiguous segments from the same source clip)
- timeline segments must be ordered by position_in_timeline
- position_in_timeline of first segment is 0
- Each segment's duration = end - start
- position_in_timeline of segment N = position_in_timeline of segment N-1 + duration of segment N-1
- total_duration must equal position_in_timeline of last segment + duration of last segment
- total_duration MUST be between {min_duration} and {max_duration} seconds
{transition_rules}
{filter_rules}
{brightness_rules}
{audio_rules}
- Return ONLY valid JSON"""


TRANSITIONS_SECTION = """
## Transitions
You should choose appropriate transitions between segments. Available transition types:
- "cut" -- instant cut (0 duration). Use for: fast pacing, same-scene continuity, high energy.
- "crossfade" -- dissolve between clips (0.3-1.0s). Use for: subtle mood shifts, related scenes, gentle pacing.
- "fade_to_black" -- fade out to black, then in (0.5-1.5s). Use for: big scene changes, time passage, dramatic pauses.
- "fade_to_white" -- fade out to white, then in (0.5-1.5s). Use for: dreamy transitions, bright/hopeful mood shifts.
- "wipe_left" -- horizontal wipe left (0.3-0.8s). Use for: location changes, energetic transitions.
- "wipe_right" -- horizontal wipe right (0.3-0.8s). Use for: location changes, energetic transitions.
- "zoom_in" -- scale up outgoing clip (0.3-0.8s). Use for: focusing in, building intensity.
- "blur" -- blur out then in (0.5-1.0s). Use for: dreamlike transitions, memory/flashback feel.

Choose transitions based on:
- Mood shift between segments (big shift = fade_to_black, subtle = crossfade)
- Energy change (high energy = hard cut or wipe, low energy = dissolve/crossfade)
- Scene change vs continuation (same scene = cut, different scene = transition)
- NOT every segment needs a non-cut transition. Use them purposefully.
- The first segment should always have type "cut" with duration 0.
"""

TRANSITION_SCHEMA_WITH = """{{\"type\": \"cut|crossfade|fade_to_black|fade_to_white|wipe_left|wipe_right|zoom_in|blur\", \"duration\": <seconds>}}"""
TRANSITION_SCHEMA_WITHOUT = "\"cut\""

TRANSITION_RULES_WITH = """- transition is an object with "type" and "duration" fields
- First segment MUST have transition: {"type": "cut", "duration": 0}
- For "cut" type, duration is always 0
- Duration ranges: crossfade 0.3-1.0, fade_to_black 0.5-1.5, fade_to_white 0.5-1.5, wipe_left/right 0.3-0.8, zoom_in 0.3-0.8, blur 0.5-1.0"""
TRANSITION_RULES_WITHOUT = "- transition is always \"cut\""


FILTERS_SECTION = """
## Filters
You may optionally apply a visual filter to individual segments. Available filters:
- "none" -- no filter (default)
- "grayscale" -- black and white, classic documentary feel
- "sepia" -- warm vintage tone
- "high_contrast" -- punchy, dramatic look
- "warm" -- warm color temperature (golden hour feel)
- "cool" -- cool color temperature (blue/clinical/modern)
- "vintage" -- faded retro look (desaturated, warm shadows)
- "dramatic" -- dark and moody (increased contrast, darker shadows)

Guidelines:
- You are NOT required to apply filters to every segment. Most segments should have "none".
- Only apply a filter when it genuinely enhances the mood or storytelling for that specific moment.
- You can apply different filters to different segments.
- Intensity controls how strongly the filter is applied (0.0 = no effect, 1.0 = full effect). Use 0.6-0.8 for subtle enhancement, 1.0 for strong stylistic choice.
"""

FILTER_FIELD_WITH = """,
      "filter": {{"type": "none|grayscale|sepia|high_contrast|warm|cool|vintage|dramatic", "intensity": <0.0-1.0>}}"""
FILTER_FIELD_WITHOUT = ""

FILTER_RULES_WITH = """- filter is optional on each segment. If omitted or type is "none", no filter is applied.
- Only apply filters purposefully -- most segments should have "none" or no filter field."""
FILTER_RULES_WITHOUT = ""


BRIGHTNESS_SECTION = """
## Brightness Correction
You should analyze the brightness_level from each clip's analysis and apply brightness corrections when adjacent segments have very different brightness levels. This prevents jarring brightness jumps in the final edit.

Guidelines:
- Add a "brightness_adjustment" field (0.8-1.2 range, 1.0 = no change) to segments that need correction.
- If a "dark" segment is next to a "bright" one, slightly brighten the dark one (1.05-1.15) or dim the bright one (0.85-0.95).
- If brightness levels are similar (e.g., both "medium"), no adjustment is needed -- omit the field or set to 1.0.
- You may also choose a fade_to_black transition to smooth large brightness gaps.
- Subtle corrections (0.9-1.1) are preferred over aggressive ones.
"""

BRIGHTNESS_FIELD_WITH = """,
      "brightness_adjustment": <0.8-1.2, optional, 1.0 = no change>"""
BRIGHTNESS_FIELD_WITHOUT = ""

BRIGHTNESS_RULES_WITH = """- brightness_adjustment is optional. If omitted, defaults to 1.0 (no change).
- Range is 0.8 to 1.2. Only apply when adjacent segments have different brightness_level values."""
BRIGHTNESS_RULES_WITHOUT = ""


AUDIO_SECTION = """
## Original Audio Control
You should control the original audio volume for each segment using keyframes. This allows precise volume
changes within a segment (e.g., fade down audio as speech starts, mute noisy sections).

Each segment includes an "audio" field with a "keyframes" array. Each keyframe:
- "time": seconds relative to the segment start (0.0 = beginning of segment)
- "volume": 0.0 (muted) to 1.0 (full volume)
- "transition": "immediate" (instant volume change) or "fade" (smooth transition)
- "fade_duration": seconds for the fade (only required when transition is "fade", 0.1-1.0s)

Guidelines for audio decisions:
- Keep at full (1.0): clip has important, relevant audio that serves the ad (clean dialogue, ambient that sets mood)
- Reduce (0.2-0.5): segment's original audio is present but will compete with speech/music layered on top
- Mute (0.0): bad audio quality (noisy/windy/echo), irrelevant background noise, silence is better
- Fade: use fades for smooth transitions between segments with different audio levels
- Volume normalization: use the overall_volume from audio analysis to balance clips
  - "loud" clips: consider starting slightly lower (0.7-0.9) for consistency
  - "quiet" clips: keep at 1.0 (boosting happens elsewhere if needed)
  - "medium" clips: default to 1.0
- First keyframe should always be at time 0.0
- Segments from clips with has_audio=false should get [{time: 0.0, volume: 0.0, transition: "immediate"}]
"""

AUDIO_FIELD_WITH = """,
      "audio": {{"keyframes": [{{"time": 0.0, "volume": <0.0-1.0>, "transition": "immediate|fade", "fade_duration": <optional, 0.1-1.0>}}]}}"""
AUDIO_FIELD_WITHOUT = ""

AUDIO_RULES_WITH = """- audio.keyframes is required on every segment. At minimum, include one keyframe at time 0.0.
- volume range: 0.0 (muted) to 1.0 (full). Use audio analysis (overall_volume, audio_quality, has_audio) to decide.
- For segments from clips with no audio (has_audio=false), use: {"keyframes": [{"time": 0.0, "volume": 0.0, "transition": "immediate"}]}
- fade_duration is only needed when transition is "fade" (0.1 to 1.0 seconds)."""
AUDIO_RULES_WITHOUT = ""


def _get_genai_client():
    """Get a google-genai client configured for Vertex AI."""
    creds_path = settings.google_application_credentials
    if creds_path and not os.path.isabs(creds_path):
        # Resolve relative to backend/ directory
        resolved = str(Path(__file__).parent.parent.parent / creds_path)
        os.environ["GOOGLE_APPLICATION_CREDENTIALS"] = resolved

    return genai.Client(
        vertexai=True,
        project=settings.google_cloud_project,
        location="global",
    )


def analyze_clip(video_file_path: str, focus: str = "") -> dict:
    """Analyze a video clip to understand its content, mood, energy, and usable segments.

    Use this tool to understand what is in a video clip before making editing decisions.
    You can call this multiple times for the same clip with different focus areas if
    the initial analysis is missing information you need.

    Args:
        video_file_path: Absolute path to the video file on disk.
        focus: Optional additional analysis focus. Use this to ask for specific details
               that were missing from a previous analysis (e.g., "focus on the text and
               signage visible in the clip" or "look more closely at seconds 5-8 for
               transition opportunities"). Leave empty for standard analysis.

    Returns:
        dict: Analysis results with status, segments, mood, best_moments, and token usage.
              On error, returns status="error" with a message.
    """
    file_path = Path(video_file_path)

    # Validate file exists
    if not file_path.exists():
        return {
            "status": "error",
            "message": f"Video file not found: {video_file_path}",
        }

    # Validate file size
    file_size = file_path.stat().st_size
    if file_size > MAX_VIDEO_SIZE_BYTES:
        return {
            "status": "error",
            "message": f"Video file too large: {file_size / 1024 / 1024:.1f}MB. Max: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f}MB.",
        }

    # Determine mime type from extension
    ext = file_path.suffix.lower()
    mime_map = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
    mime_type = mime_map.get(ext, "video/mp4")

    # Read video bytes
    video_bytes = file_path.read_bytes()
    video_part = Part.from_bytes(data=video_bytes, mime_type=mime_type)

    # Build prompt with optional focus
    additional_focus = ""
    if focus:
        additional_focus = f"\nADDITIONAL FOCUS: {focus}\nPay special attention to this aspect in your analysis."

    prompt = ANALYZE_CLIP_PROMPT.format(additional_focus=additional_focus)

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[video_part, prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        analysis = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    analysis["status"] = "success"
    analysis["file_path"] = video_file_path
    analysis["input_tokens"] = input_tokens
    analysis["output_tokens"] = output_tokens

    return analysis


def analyze_clip_audio(video_file_path: str, focus: str = "") -> dict:
    """Analyze the audio track of a video clip to understand its sound content.

    Use this tool to understand what is in the audio of a video clip before making
    editing decisions about volume, speech, and music. You should call this for every
    clip alongside analyze_clip (which covers visuals).

    You can call this multiple times for the same clip with different focus areas if
    the initial audio analysis is missing information.

    Args:
        video_file_path: Absolute path to the video file on disk.
        focus: Optional additional analysis focus. Use this to ask for specific audio
               details that were missing from a previous analysis (e.g., "listen more
               closely for background music" or "focus on the speech between seconds
               5-10"). Leave empty for standard audio analysis.

    Returns:
        dict: Audio analysis results with status, has_audio, audio_type, volume info,
              speech content, audio moments, and token usage.
              On error, returns status="error" with a message.
    """
    file_path = Path(video_file_path)

    # Validate file exists
    if not file_path.exists():
        return {
            "status": "error",
            "message": f"Video file not found: {video_file_path}",
        }

    # Validate file size
    file_size = file_path.stat().st_size
    if file_size > MAX_VIDEO_SIZE_BYTES:
        return {
            "status": "error",
            "message": f"Video file too large: {file_size / 1024 / 1024:.1f}MB. Max: {MAX_VIDEO_SIZE_BYTES / 1024 / 1024:.0f}MB.",
        }

    # Determine mime type from extension
    ext = file_path.suffix.lower()
    mime_map = {".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm"}
    mime_type = mime_map.get(ext, "video/mp4")

    # Read video bytes
    video_bytes = file_path.read_bytes()
    video_part = Part.from_bytes(data=video_bytes, mime_type=mime_type)

    # Build prompt with optional focus
    additional_focus = ""
    if focus:
        additional_focus = f"\nADDITIONAL FOCUS: {focus}\nPay special attention to this aspect in your audio analysis."

    prompt = ANALYZE_CLIP_AUDIO_PROMPT.format(additional_focus=additional_focus)

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[video_part, prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        analysis = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse audio analysis response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    analysis["status"] = "success"
    analysis["file_path"] = video_file_path
    analysis["input_tokens"] = input_tokens
    analysis["output_tokens"] = output_tokens

    return analysis


def generate_edit_plan(
    clip_analyses_json: str,
    brief: str,
    min_duration: int,
    max_duration: int,
    variation: str = "balanced",
    add_transitions: bool = True,
    allow_filters: bool = True,
    auto_brightness: bool = True,
    manage_audio: bool = True,
) -> dict:
    """Generate one timeline proposal for a video advertisement.

    Takes all clip analyses, the creative brief, and a creative direction,
    then produces a structured timeline proposal with reasoning.

    Args:
        clip_analyses_json: JSON string of all clip analyses (array of analysis dicts).
        brief: The creative brief describing what the ad should achieve
               (e.g., "30-second energetic travel destination ad").
        min_duration: Minimum total duration in seconds for the timeline.
        max_duration: Maximum total duration in seconds for the timeline.
        variation: Creative direction for this proposal. Examples:
                   "fast pacing with rapid cuts",
                   "slow cinematic story arc",
                   "focus on mood and atmosphere",
                   "experimental and unconventional",
                   "balanced professional edit".
        add_transitions: Whether to include transition effects between segments.
                         When True, the agent will choose appropriate transitions
                         (crossfade, fade_to_black, wipe, etc.) based on mood and energy.
                         When False, all transitions will be simple cuts.
        allow_filters: Whether to allow visual filters on segments.
                       When True, the agent may apply filters (grayscale, sepia, warm, etc.)
                       to individual segments to enhance mood. Not required on every segment.
                       When False, no filters will be applied.
        auto_brightness: Whether to auto-correct brightness between adjacent segments.
                         When True, the agent will analyze brightness_level from clip analyses
                         and apply brightness_adjustment (0.8-1.2) to smooth jumps.
                         When False, no brightness correction is applied.
        manage_audio: Whether to include original audio volume keyframes per segment.
                      When True, the agent will control original audio volume with keyframes
                      based on audio analysis (quality, type, volume level).
                      When False, no audio field is included (all segments play at full volume).

    Returns:
        dict: Proposal with status, label, reasoning, timeline, clips_not_used, and token usage.
              On error, returns status="error" with a message.
    """
    # Enforce proposal limit -- prevents runaway generation
    if not _check_proposal_limit():
        return {
            "status": "error",
            "message": f"Maximum number of proposals ({_proposal_limit}) already generated. Do not call this tool again.",
        }

    # Parse clip analyses
    try:
        clip_analyses = json.loads(clip_analyses_json)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Invalid clip_analyses_json: {e}",
        }

    # Build prompt with conditional transitions, filters, brightness, and audio
    transitions_section = TRANSITIONS_SECTION if add_transitions else ""
    transition_schema = TRANSITION_SCHEMA_WITH if add_transitions else TRANSITION_SCHEMA_WITHOUT
    transition_rules = TRANSITION_RULES_WITH if add_transitions else TRANSITION_RULES_WITHOUT
    filters_section = FILTERS_SECTION if allow_filters else ""
    filter_field = FILTER_FIELD_WITH if allow_filters else FILTER_FIELD_WITHOUT
    filter_rules = FILTER_RULES_WITH if allow_filters else FILTER_RULES_WITHOUT
    brightness_section = BRIGHTNESS_SECTION if auto_brightness else ""
    brightness_field = BRIGHTNESS_FIELD_WITH if auto_brightness else BRIGHTNESS_FIELD_WITHOUT
    brightness_rules = BRIGHTNESS_RULES_WITH if auto_brightness else BRIGHTNESS_RULES_WITHOUT
    audio_section = AUDIO_SECTION if manage_audio else ""
    audio_field = AUDIO_FIELD_WITH if manage_audio else AUDIO_FIELD_WITHOUT
    audio_rules = AUDIO_RULES_WITH if manage_audio else AUDIO_RULES_WITHOUT

    prompt = GENERATE_EDIT_PLAN_PROMPT.format(
        brief=brief,
        min_duration=min_duration,
        max_duration=max_duration,
        variation_instruction=variation,
        clip_analyses_json=json.dumps(clip_analyses, indent=2),
        transitions_section=transitions_section,
        transition_schema=transition_schema,
        transition_rules=transition_rules,
        filters_section=filters_section,
        filter_field=filter_field,
        filter_rules=filter_rules,
        brightness_section=brightness_section,
        brightness_field=brightness_field,
        brightness_rules=brightness_rules,
        audio_section=audio_section,
        audio_field=audio_field,
        audio_rules=audio_rules,
    )

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        proposal = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    # Validate duration
    total_duration = proposal.get("total_duration", 0)
    if total_duration < min_duration or total_duration > max_duration:
        proposal["duration_warning"] = (
            f"Total duration {total_duration}s is outside constraints "
            f"({min_duration}-{max_duration}s)"
        )

    proposal["status"] = "success"
    proposal["input_tokens"] = input_tokens
    proposal["output_tokens"] = output_tokens

    # Only count as generated after successful completion
    _increment_proposal_count()

    return proposal


GENERATE_SPEECH_SCRIPT_PROMPT = """You are a voiceover writer for video advertisements. You have a timeline proposal and clip analyses, and you need to write a voiceover script that complements the visuals.

## Creative Brief
{brief}

## Timeline Proposal
{timeline_proposal_json}

## Clip Analyses (Video + Audio)
{clip_analyses_json}

## Voice Settings
- Voice: {voice_name}
- Default speaking rate: {speaking_rate}

## Your Task
Write a voiceover script as chunked speech segments aligned to the timeline. Each chunk is independently rendered as audio.

Return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{{
  "speech": [
    {{
      "chunk_id": "sp_01",
      "text": "The actual words to speak",
      "start_time": <seconds - when this chunk starts in the timeline>,
      "end_time": <seconds - when this chunk ends in the timeline>,
      "speaking_rate": <0.5-2.0 - speed for this specific chunk>,
      "reason": "Brief explanation of why this text fits here"
    }}
  ]
}}

## Rules
- ALIGN chunks to scene cuts: speech should start/end at or near segment boundaries in the timeline
- LEAVE GAPS between chunks: let original audio and music breathe. Not every second needs speech.
- NOT EVERY SEGMENT needs speech: silence is a powerful tool. Use it.
- COMPLEMENT the visual: describe the feeling or message, do not literally describe what is shown on screen
- Keep chunks SHORT: 1-3 sentences maximum per chunk
- chunk_id format: "sp_01", "sp_02", "sp_03", etc. (sequential)
- start_time and end_time must not overlap with other chunks
- end_time - start_time should be a reasonable duration for the text (roughly 2-4 words per second at 1.0x rate)
- speaking_rate: adjust per chunk if needed (0.5-2.0). Use the default rate unless the moment calls for faster/slower delivery.
  - Energetic moments: slightly faster (1.1-1.3)
  - Dramatic/emotional moments: slightly slower (0.8-0.9)
  - Normal narration: 1.0
- Consider the brief tone:
  - Energetic brief = punchy, short phrases with pauses between
  - Calm brief = flowing, longer sentences with gentle pacing
  - Professional brief = clear, measured delivery
  - Dramatic brief = varied pacing, building intensity
- Total speech should cover roughly 30-60%% of the timeline duration (leave 40-70%% for original audio/music/silence)
- If clip audio analysis shows important dialogue or music, leave that segment without voiceover
- Return ONLY valid JSON, nothing else"""


def generate_speech_script(
    clip_analyses_json: str,
    timeline_proposal_json: str,
    brief: str,
    voice_name: str = "en-US-Journey-D",
    speaking_rate: float = 1.0,
    speech_context: str = "",
) -> dict:
    """Generate a voiceover script aligned to a timeline proposal.

    Writes chunked speech that complements the visuals in the timeline.
    Each chunk is independently renderable as TTS audio.

    Call this ONLY when voiceover is enabled in settings. Call it once per proposal
    that you want to add voiceover to.

    Args:
        clip_analyses_json: JSON string of all clip analyses (video + audio data).
        timeline_proposal_json: JSON string of the timeline proposal to write speech for.
        brief: The creative brief for tone/style guidance.
        voice_name: Selected TTS voice name (e.g., "en-US-Journey-D").
        speaking_rate: Default speaking rate (0.5-2.0, 1.0 = normal). Agent may adjust per chunk.
        speech_context: Optional user-provided notes about what the voiceover should say.
                        May include key points to cover, exact phrases to use verbatim,
                        tone guidance, or ordering hints. Use as primary content guide when provided.

    Returns:
        dict: Speech script with status and speech array of chunks.
              On error, returns status="error" with a message.
    """
    # Validate inputs
    try:
        clip_analyses = json.loads(clip_analyses_json)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Invalid clip_analyses_json: {e}",
        }

    try:
        timeline_proposal = json.loads(timeline_proposal_json)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Invalid timeline_proposal_json: {e}",
        }

    # Clamp speaking rate
    speaking_rate = max(0.5, min(2.0, speaking_rate))

    # Build speech context section
    speech_context_section = ""
    if speech_context and speech_context.strip():
        speech_context_section = (
            f"\n## Speech Notes (from user)\n"
            f"The user has provided specific notes about what the voiceover should say. "
            f"Use these as your PRIMARY guide for speech content. If exact phrases are specified, "
            f"incorporate them verbatim. Align the speech to the visual content -- place relevant "
            f"phrases over relevant clips.\n\n"
            f"{speech_context.strip()}\n"
        )

    # Build prompt
    prompt = GENERATE_SPEECH_SCRIPT_PROMPT.format(
        brief=brief,
        timeline_proposal_json=json.dumps(timeline_proposal, indent=2),
        clip_analyses_json=json.dumps(clip_analyses, indent=2),
        voice_name=voice_name,
        speaking_rate=speaking_rate,
    )

    # Insert speech context after the brief section
    if speech_context_section:
        prompt = prompt.replace(
            "## Timeline Proposal",
            f"{speech_context_section}\n## Timeline Proposal",
        )

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        result = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse speech script response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    result["status"] = "success"
    result["input_tokens"] = input_tokens
    result["output_tokens"] = output_tokens

    return result


# --- Background Music (Jamendo) ---

import requests

SELECT_MUSIC_PROMPT = """You are selecting background music for a video advertisement.

## Context
- Creative brief: {brief}
- Timeline duration: {timeline_duration} seconds
- Mood keywords: {mood_keywords}
{speech_info}

## Available Tracks from Jamendo
{tracks_json}

## Your Task
Select the BEST matching track for this video. Consider:
1. Mood alignment with the brief and visual content
2. Energy level matching the pacing
3. Duration (should be >= timeline duration ideally, or at least close)
4. Genre/tags relevance

Also decide:
- track_start: How many seconds into the track to begin playback (skip long intros, find a good entry point). Use 0 if the track starts well immediately.
- reason: A brief explanation of why this track fits.

Return ONLY valid JSON:
{{
  "selected_track_index": <0-based index into the tracks array>,
  "track_start": <seconds into the track to begin>,
  "reason": "Why this track was selected"
}}"""


def _search_jamendo(mood_keywords: str, duration: float, genre_hint: str = "") -> list[dict]:
    """Search Jamendo API for tracks matching mood/genre criteria."""
    client_id = settings.jamendo_client_id
    if not client_id:
        return []

    # Build search parameters
    params = {
        "client_id": client_id,
        "format": "json",
        "limit": 10,
        "audiodlformat": "mp32",
        "order": "relevance",
        "include": "musicinfo",
        "vocalinstrumental": "instrumental",
    }

    # Use search param (most reliable for multi-word queries)
    search_terms = mood_keywords.replace(",", " ").strip()
    if genre_hint:
        search_terms = f"{search_terms} {genre_hint}".strip()
    if search_terms:
        params["search"] = search_terms

    # Duration filter: prefer tracks at least as long as the timeline
    min_dur = max(int(duration) - 10, 15)
    params["duration_between"] = f"{min_dur}_600"

    try:
        resp = requests.get(
            "https://api.jamendo.com/v3.0/tracks",
            params=params,
            timeout=15,
        )
        resp.raise_for_status()
        data = resp.json()
        results = data.get("results", [])

        # If no results with full search, try with just the first keyword
        if not results and " " in search_terms:
            first_keyword = search_terms.split()[0]
            params["search"] = first_keyword
            resp = requests.get(
                "https://api.jamendo.com/v3.0/tracks",
                params=params,
                timeout=15,
            )
            resp.raise_for_status()
            data = resp.json()
            results = data.get("results", [])

        # Simplify track data for the agent
        tracks = []
        for track in results:
            musicinfo = track.get("musicinfo", {})
            tags = musicinfo.get("tags", {})
            # Flatten all tag categories into a single list
            all_tags = []
            if isinstance(tags, dict):
                for tag_list in tags.values():
                    if isinstance(tag_list, list):
                        all_tags.extend(tag_list)

            tracks.append({
                "id": track.get("id"),
                "name": track.get("name", ""),
                "artist_name": track.get("artist_name", ""),
                "duration": track.get("duration", 0),
                "audio": track.get("audio", ""),
                "audiodownload": track.get("audiodownload", ""),
                "tags": all_tags[:10],  # Limit tags for prompt size
            })

        return tracks
    except Exception:
        return []


def _build_volume_keyframes(
    timeline_duration: float,
    speech_chunks: list[dict],
    normal_volume: float = 0.5,
    ducked_volume: float = 0.2,
    fade_in_duration: float = 1.0,
    fade_out_duration: float = 2.0,
    duck_fade: float = 0.4,
) -> list[dict]:
    """Build volume keyframes with auto-ducking under speech chunks.

    Creates a volume envelope that:
    - Fades in at the start
    - Ducks under speech chunks
    - Restores between speech
    - Fades out at the end
    """
    keyframes = []

    # Fade in
    keyframes.append({"time": 0.0, "volume": 0.0, "transition": "fade", "fade_duration": fade_in_duration})
    keyframes.append({"time": fade_in_duration, "volume": normal_volume, "transition": "fade", "fade_duration": 0.0})

    # Duck under speech chunks
    if speech_chunks:
        # Sort chunks by start_time
        sorted_chunks = sorted(speech_chunks, key=lambda c: c.get("start_time", 0))

        for chunk in sorted_chunks:
            chunk_start = chunk.get("start_time", 0)
            chunk_end = chunk.get("end_time", chunk_start + 3.0)

            # Don't duck if the chunk is in the fade-in or fade-out region
            if chunk_start < fade_in_duration + 0.5:
                # Already fading in, just set ducked volume at chunk start
                keyframes.append({"time": max(chunk_start, fade_in_duration), "volume": ducked_volume, "transition": "fade", "fade_duration": duck_fade})
            else:
                # Duck before speech starts
                keyframes.append({"time": chunk_start - duck_fade, "volume": normal_volume, "transition": "fade", "fade_duration": 0.0})
                keyframes.append({"time": chunk_start, "volume": ducked_volume, "transition": "fade", "fade_duration": duck_fade})

            # Restore after speech ends
            if chunk_end < timeline_duration - fade_out_duration - 0.5:
                keyframes.append({"time": chunk_end, "volume": ducked_volume, "transition": "fade", "fade_duration": 0.0})
                keyframes.append({"time": chunk_end + duck_fade, "volume": normal_volume, "transition": "fade", "fade_duration": duck_fade})

    # Fade out
    fade_out_start = max(timeline_duration - fade_out_duration, fade_in_duration + 1.0)
    keyframes.append({"time": fade_out_start, "volume": normal_volume, "transition": "fade", "fade_duration": 0.0})
    keyframes.append({"time": timeline_duration, "volume": 0.0, "transition": "fade", "fade_duration": fade_out_duration})

    # Remove duplicates and sort by time
    seen_times = set()
    unique_keyframes = []
    for kf in sorted(keyframes, key=lambda k: k["time"]):
        t = round(kf["time"], 2)
        if t not in seen_times:
            seen_times.add(t)
            kf["time"] = t
            unique_keyframes.append(kf)

    return unique_keyframes


def select_background_music(
    brief: str,
    mood_keywords: str,
    timeline_duration: float,
    speech_chunks_json: str = "[]",
    genre_hint: str = "",
) -> dict:
    """Select a background music track from Jamendo for the video timeline.

    Searches Jamendo for tracks matching the mood/genre of the brief, then selects
    the best-fitting track. Automatically generates volume keyframes that duck
    under speech chunks.

    Call this ONLY when background music is enabled in settings. Call it once per
    proposal, after generating the edit plan (and speech script if voiceover is enabled).

    Args:
        brief: The creative brief describing the video's intent and mood.
        mood_keywords: Comma-separated mood/genre keywords derived from the brief
                      and visual analysis (e.g., "calm, acoustic, travel, peaceful").
        timeline_duration: Total duration of the proposal timeline in seconds.
        speech_chunks_json: JSON string of speech chunks array (from generate_speech_script).
                          Used to auto-duck music volume during speech. Pass "[]" if no speech.
        genre_hint: Optional specific genre tag for Jamendo search (e.g., "electronic", "classical").

    Returns:
        dict: Music selection with placement data and volume keyframes.
              On error, returns status="error" with a message.
    """
    # Parse speech chunks
    try:
        speech_chunks = json.loads(speech_chunks_json)
    except json.JSONDecodeError:
        speech_chunks = []

    # Search Jamendo
    tracks = _search_jamendo(mood_keywords, timeline_duration, genre_hint)

    if not tracks:
        return {
            "status": "error",
            "message": "No tracks found on Jamendo matching the criteria. Try different mood_keywords or genre_hint.",
        }

    # Build speech info for the selection prompt
    speech_info = ""
    if speech_chunks:
        speech_times = ", ".join(
            f"{c.get('start_time', 0):.1f}-{c.get('end_time', 0):.1f}s"
            for c in speech_chunks[:10]
        )
        speech_info = f"- Speech chunks present at: {speech_times} (music should duck under these)"
    else:
        speech_info = "- No speech/voiceover (music can play at consistent volume)"

    # Ask Gemini to select the best track
    prompt = SELECT_MUSIC_PROMPT.format(
        brief=brief,
        timeline_duration=timeline_duration,
        mood_keywords=mood_keywords,
        speech_info=speech_info,
        tracks_json=json.dumps(tracks, indent=2),
    )

    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed during music selection: {e}",
        }

    # Parse selection response
    raw_text = response.text.strip()
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        selection = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse music selection response: {e}",
            "raw_response": raw_text[:500],
        }

    # Get the selected track
    track_index = selection.get("selected_track_index", 0)
    if track_index < 0 or track_index >= len(tracks):
        track_index = 0

    selected_track = tracks[track_index]
    track_start = max(0.0, float(selection.get("track_start", 0)))
    reason = selection.get("reason", "Best mood match for the brief")

    # Calculate placement
    track_duration = int(selected_track.get("duration", 0))
    available_from_start = track_duration - track_start
    end_time = min(timeline_duration, available_from_start)

    # Build volume keyframes with auto-ducking
    volume_keyframes = _build_volume_keyframes(
        timeline_duration=end_time,
        speech_chunks=speech_chunks,
    )

    # Build the music result
    music_data = {
        "track_id": str(selected_track.get("id", "")),
        "title": selected_track.get("name", ""),
        "artist": selected_track.get("artist_name", ""),
        "url": selected_track.get("audiodownload", "") or selected_track.get("audio", ""),
        "preview_url": selected_track.get("audio", ""),
        "duration": track_duration,
        "tags": selected_track.get("tags", []),
        "placement": {
            "start_time": 0.0,
            "end_time": round(end_time, 2),
            "track_start": round(track_start, 2),
        },
        "volume_keyframes": volume_keyframes,
        "reason": reason,
    }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    return {
        "status": "success",
        "music": music_data,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }


# --- Text Overlays (Captions & Titles) ---

GENERATE_TEXT_OVERLAYS_PROMPT = """You are a motion graphics editor for video advertisements. You have a finished timeline proposal (and optionally a voiceover script), and you decide what on-screen text to add.

## Creative Brief
{brief}

## Timeline Proposal
{timeline_proposal_json}
{speech_section}
## What You May Add
{allowed_types_section}

## Text Overlay Types
- "title" -- a title card. Full-screen or centered headline text. Use for an intro headline or section header. Position: "center".
- "lower_third" -- text in the lower portion of the frame (names, locations, labels, short factual notes). Position: "lower".
- "caption" -- transcription/subtitle of spoken words, timed to match speech. Position: "lower".
- "end_card" -- closing message shown near the end (a call to action, brand name, "Subscribe", "Learn more"). Position: "center" or "lower".

## Your Task
Decide the on-screen text for this video and return it as a list of overlays. Base your decisions on the brief, the visual timeline, and (if present) the voiceover script.

Return ONLY valid JSON (no markdown, no code fences) with this exact schema:
{{
  "text_overlays": [
    {{
      "id": "txt_01",
      "type": "title|lower_third|caption|end_card",
      "text": "The words shown on screen",
      "start_time": <seconds - when the overlay appears in the timeline>,
      "end_time": <seconds - when the overlay disappears>,
      "position": "center|lower|upper",
      "style": {{"font_size": "small|medium|large", "color": "#ffffff", "background": "none|semi|solid"}},
      "animation": "fade|slide|none"
    }}
  ]
}}

## Rules
- id format: "txt_01", "txt_02", "txt_03", etc. (sequential)
- start_time and end_time are in TIMELINE seconds (not clip-relative). end_time must be greater than start_time.
- Keep overlays on screen long enough to read: aim for at least 1.5s, longer for more words (~2-3 words per second of reading time).
{caption_rules}
{title_rules}
- Do NOT overload the screen. Overlays of the same type generally should not overlap in time.
- position: "center" for titles/end cards, "lower" for lower thirds and captions, "upper" only when the lower area is busy.
- style.font_size: "large" for titles/end cards, "medium" for lower thirds, "small"-"medium" for captions.
- style.color: default "#ffffff" (white). Use a readable color; light text over video usually needs a background.
- style.background: "none" (text only), "semi" (semi-transparent box behind text, best for readability over busy footage), "solid" (opaque box). Prefer "semi" for captions and lower thirds.
- animation: "fade" (fade in/out), "slide" (slide in), or "none". Titles often "fade", lower thirds often "slide", captions usually "fade" or "none".
- If there is nothing meaningful to add, return an empty text_overlays array.
- Return ONLY valid JSON, nothing else"""


CAPTION_RULES_ON = """- CAPTIONS: Generate one "caption" overlay per speech chunk. Set text to the chunk's spoken words, start_time to the chunk's start_time, and end_time to the chunk's end_time. Captions must match the speech timing exactly. If the spoken text is long, you may split it across the chunk's time range but keep timing within the chunk."""
CAPTION_RULES_OFF = """- CAPTIONS: Do NOT generate any "caption" overlays."""

TITLE_RULES_ON = """- TITLES/LOWER THIRDS/END CARDS: You DECIDE where these help. A short intro title over the opening shot, lower thirds for locations or labels when relevant, and an end card near the very end if the brief implies a call to action or brand. Use them sparingly and purposefully -- not every video needs a title, and most do not need lower thirds. Base placement on the visual content and brief."""
TITLE_RULES_OFF = """- TITLES/LOWER THIRDS/END CARDS: Do NOT generate any "title", "lower_third", or "end_card" overlays."""


def generate_text_overlays(
    timeline_proposal_json: str,
    brief: str,
    speech_chunks_json: str = "[]",
    add_captions: bool = False,
    add_titles: bool = True,
) -> dict:
    """Generate on-screen text overlays (titles, lower thirds, captions, end cards) for a timeline proposal.

    Decides what text to display over the video based on the brief, the timeline, and
    (optionally) the voiceover script. Captions are generated from speech chunks and timed
    to match them; titles/lower thirds/end cards are placed by editorial judgment.

    Call this ONLY when captions or titles are enabled in settings. Call it once per proposal,
    after generating the edit plan (and the speech script if voiceover is enabled, so captions
    can be timed to the speech).

    Args:
        timeline_proposal_json: JSON string of the timeline proposal to add text to.
        brief: The creative brief for tone/style guidance.
        speech_chunks_json: JSON string of speech chunks array (from generate_speech_script).
                          Used to generate captions timed to speech. Pass "[]" if no speech.
        add_captions: Whether to generate captions (subtitles) from the speech chunks.
                      When True and speech chunks are present, one caption per chunk is created.
        add_titles: Whether to allow title cards, lower thirds, and end cards.
                    When True, the agent decides where these enhance the video.
                    When False, no titles/lower thirds/end cards are generated.

    Returns:
        dict: Text overlays with status and text_overlays array.
              On error, returns status="error" with a message.
    """
    # Validate inputs
    try:
        timeline_proposal = json.loads(timeline_proposal_json)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Invalid timeline_proposal_json: {e}",
        }

    try:
        speech_chunks = json.loads(speech_chunks_json)
    except json.JSONDecodeError:
        speech_chunks = []

    # If nothing is enabled, return empty (agent shouldn't call it, but guard anyway)
    if not add_captions and not add_titles:
        return {"status": "success", "text_overlays": []}

    # Captions require speech chunks
    captions_effective = add_captions and bool(speech_chunks)

    # Build the speech section (only relevant when captions are on and chunks exist)
    speech_section = ""
    if captions_effective:
        speech_section = (
            "\n## Voiceover Script (for captions)\n"
            "Generate one caption per chunk below, matching its text and timing exactly.\n"
            f"{json.dumps(speech_chunks, indent=2)}\n"
        )

    # Describe what the agent is allowed to add
    allowed = []
    if captions_effective:
        allowed.append("captions (subtitles timed to the voiceover)")
    if add_titles:
        allowed.append("titles, lower thirds, and end cards (where they enhance the video)")
    allowed_types_section = "You may add: " + "; ".join(allowed) + "."

    caption_rules = CAPTION_RULES_ON if captions_effective else CAPTION_RULES_OFF
    title_rules = TITLE_RULES_ON if add_titles else TITLE_RULES_OFF

    prompt = GENERATE_TEXT_OVERLAYS_PROMPT.format(
        brief=brief,
        timeline_proposal_json=json.dumps(timeline_proposal, indent=2),
        speech_section=speech_section,
        allowed_types_section=allowed_types_section,
        caption_rules=caption_rules,
        title_rules=title_rules,
    )

    # Call Gemini
    client = _get_genai_client()
    try:
        response = client.models.generate_content(
            model="gemini-3.5-flash",
            contents=[prompt],
        )
    except Exception as e:
        return {
            "status": "error",
            "message": f"Gemini API call failed during text overlay generation: {e}",
        }

    # Extract token usage
    input_tokens = 0
    output_tokens = 0
    if response.usage_metadata:
        input_tokens = response.usage_metadata.prompt_token_count or 0
        output_tokens = response.usage_metadata.candidates_token_count or 0

    # Parse response JSON
    raw_text = response.text.strip()

    # Strip markdown code fences if present
    if raw_text.startswith("```"):
        lines = raw_text.split("\n")
        lines = [line for line in lines if not line.strip().startswith("```")]
        raw_text = "\n".join(lines)

    try:
        result = json.loads(raw_text)
    except json.JSONDecodeError as e:
        return {
            "status": "error",
            "message": f"Failed to parse text overlays response as JSON: {e}",
            "raw_response": raw_text[:500],
            "input_tokens": input_tokens,
            "output_tokens": output_tokens,
        }

    overlays = result.get("text_overlays", [])
    if not isinstance(overlays, list):
        overlays = []

    return {
        "status": "success",
        "text_overlays": overlays,
        "input_tokens": input_tokens,
        "output_tokens": output_tokens,
    }
