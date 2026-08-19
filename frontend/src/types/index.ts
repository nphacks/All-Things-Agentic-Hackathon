/** Clip metadata returned after upload */
export interface ClipMetadata {
  clip_id: string;
  filename: string;
  file_path: string;
  size_bytes: number;
}

/** Settings for a job */
export interface JobSettings {
  min_duration: number;
  max_duration: number;
  num_proposals: number;
  variations: string[];
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
  input_tokens?: number;
  output_tokens?: number;
  status?: string;
}

/** A single segment in a proposal timeline */
export interface TimelineSegment {
  clip_id: string;
  filename: string;
  start: number;
  end: number;
  position_in_timeline: number;
  transition: string;
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
  clips: { clip_id: string; filename: string; file_path: string }[];
  clip_analyses: Record<string, ClipAnalysis>;
  proposals: Proposal[];
  created_at: string | null;
  updated_at: string | null;
}

/** Proposals-only response */
export interface ProposalsResponse {
  job_id: string;
  status: string;
  proposals: Proposal[];
}
