/** Clip metadata returned after upload */
export interface ClipMetadata {
  clip_id: string;
  filename: string;
  file_path: string;
  size_bytes: number;
  gcs_url?: string;
}

/** Settings for a job */
export interface JobSettings {
  min_duration: number;
  max_duration: number;
  num_proposals: number;
  variations: string[];
  add_transitions: boolean;
  allow_filters: boolean;
  auto_brightness: boolean;
  manage_audio: boolean;
  add_voiceover: boolean;
  voice_name: string;
  speaking_rate: number;
  speech_context: string;
  add_background_music: boolean;
}

/** A single segment in a clip analysis */
export interface ClipSegment {
  start: number;
  end: number;
  description: string;
  mood: string;
  energy: "low" | "medium" | "high";
  visual_quality: "low" | "medium" | "high";
  usability: string;
}

/** Best moment from a clip analysis */
export interface BestMoment {
  time: number;
  why: string;
}

/** Full clip analysis result */
export interface ClipAnalysis {
  duration_seconds: number;
  segments: ClipSegment[];
  overall_mood: string;
  best_moments: BestMoment[];
  has_text: boolean;
  has_faces: boolean;
  perceived_speed?: "timelapse" | "fast_motion" | "normal" | "slow_motion" | "static";
  motion_intensity?: number;
  brightness_level?: "dark" | "medium" | "bright";
  has_internal_cuts?: boolean;
  input_tokens?: number;
  output_tokens?: number;
  status?: string;
}

/** Transition between timeline segments */
export interface Transition {
  type: "cut" | "crossfade" | "fade_to_black" | "fade_to_white" | "wipe_left" | "wipe_right" | "zoom_in" | "blur";
  duration: number;
}

/** Filter applied to a timeline segment */
export interface Filter {
  type: "none" | "grayscale" | "sepia" | "high_contrast" | "warm" | "cool" | "vintage" | "dramatic";
  intensity: number;
}

/** Audio keyframe for volume control */
export interface AudioKeyframe {
  time: number;
  volume: number;
  transition: "immediate" | "fade";
  fade_duration?: number;
}

/** Audio control for a timeline segment */
export interface SegmentAudio {
  keyframes: AudioKeyframe[];
}

/** A single segment in a proposal timeline */
export interface TimelineSegment {
  clip_id: string;
  filename: string;
  start: number;
  end: number;
  position_in_timeline: number;
  transition: Transition | string;
  filter?: Filter;
  brightness_adjustment?: number;
  audio?: SegmentAudio;
}

/** A generated proposal */
export interface Proposal {
  label: string;
  reasoning: string;
  total_duration: number;
  timeline: TimelineSegment[];
  clips_not_used: string[];
  clips_not_used_reason: string;
  status?: string;
  input_tokens?: number;
  output_tokens?: number;
}

/** Job creation response */
export interface JobCreateResponse {
  job_id: string;
  status: string;
}

/** Full job status response */
export interface JobStatus {
  job_id: string;
  status: "pending" | "analyzing" | "generating" | "completed" | "failed";
  progress: string | null;
  brief: string | null;
  error: string | null;
  clips: { clip_id: string; filename: string; file_path: string; gcs_url?: string }[];
  clip_analyses: Record<string, ClipAnalysis>;
  proposals: Proposal[];
  edit_log?: { action: string; clip?: string; clips?: string[]; track?: string; artist?: string; summary?: string; reason?: string }[];
  created_at: string | null;
  updated_at: string | null;
}

/** Proposals-only response */
export interface ProposalsResponse {
  job_id: string;
  status: string;
  proposals: Proposal[];
}
