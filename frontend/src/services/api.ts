import type {
  ClipMetadata,
  JobCreateResponse,
  JobSettings,
  JobStatus,
  ProposalsResponse,
} from "../types";

const BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

class ApiError extends Error {
  status: number;
  detail: unknown;

  constructor(status: number, detail: unknown) {
    super(typeof detail === "string" ? detail : JSON.stringify(detail));
    this.status = status;
    this.detail = detail;
  }
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.json().catch(() => response.statusText);
    throw new ApiError(response.status, body.detail || body);
  }
  return response.json() as Promise<T>;
}

/** Upload video clips. Returns metadata for each uploaded clip. */
export async function uploadClips(
  files: File[],
  jobId?: string,
  projectId?: string
): Promise<ClipMetadata[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  if (jobId) {
    formData.append("job_id", jobId);
  }
  if (projectId) {
    formData.append("project_id", projectId);
  }

  const response = await fetch(`${BASE_URL}/clips/upload`, {
    method: "POST",
    body: formData,
  });
  return handleResponse<ClipMetadata[]>(response);
}

/** Clip from the global media library. */
export interface LibraryClip {
  clip_id: string;
  filename: string;
  gcs_url: string;
  duration: number | null;
  source_project_id: string;
}

/** Fetch all clips across all projects (global media library). */
export async function getClipLibrary(): Promise<LibraryClip[]> {
  const response = await fetch(`${BASE_URL}/clips/library`);
  return handleResponse<LibraryClip[]>(response);
}

/** Add a clip from the global library to a project (no re-upload). */
export async function addClipFromLibrary(
  projectId: string,
  clip: { clip_id: string; filename: string; gcs_url: string }
): Promise<void> {
  const response = await fetch(`${BASE_URL}/clips/library/add`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      project_id: projectId,
      clip_id: clip.clip_id,
      filename: clip.filename,
      gcs_url: clip.gcs_url,
    }),
  });
  await handleResponse(response);
}

/** Create a new editing job. Returns immediately with job_id. */
export async function createJob(
  brief: string,
  clipIds: string[],
  settings: JobSettings,
  projectId?: string
): Promise<JobCreateResponse> {
  const body: Record<string, unknown> = {
    brief,
    clip_ids: clipIds,
    settings,
  };
  if (projectId) {
    body.project_id = projectId;
  }

  const response = await fetch(`${BASE_URL}/jobs/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<JobCreateResponse>(response);
}

/** Get full job status including progress, analyses, and proposals. */
export async function getJob(jobId: string): Promise<JobStatus> {
  const response = await fetch(`${BASE_URL}/jobs/${jobId}`);
  return handleResponse<JobStatus>(response);
}

/** Get just the proposals for a job. */
export async function getProposals(jobId: string): Promise<ProposalsResponse> {
  const response = await fetch(`${BASE_URL}/jobs/${jobId}/proposals`);
  return handleResponse<ProposalsResponse>(response);
}

/** Save edited proposals back to Firestore. */
export async function saveProposals(
  jobId: string,
  proposals: Record<string, unknown>[]
): Promise<void> {
  const response = await fetch(`${BASE_URL}/jobs/${jobId}/proposals`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(proposals),
  });
  await handleResponse<{ status: string }>(response);
}

// --- Project endpoints ---

export interface ProjectListItem {
  project_id: string;
  name: string;
  clip_count: number;
  job_count: number;
  status: string;
  created_at: string | null;
  updated_at: string | null;
  thumbnail_url: string | null;
}

export interface Project {
  project_id: string;
  name: string;
  clips: { clip_id: string; filename: string; gcs_url: string; duration?: number; thumbnail_url?: string; source?: "upload" | "generated" }[];
  jobs: string[];
  status: string;
  created_at: string | null;
  updated_at: string | null;
}

/** Create a new project. */
export async function createProject(name: string): Promise<Project> {
  const response = await fetch(`${BASE_URL}/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return handleResponse<Project>(response);
}

/** List all active projects. */
export async function listProjects(): Promise<ProjectListItem[]> {
  const response = await fetch(`${BASE_URL}/projects`);
  return handleResponse<ProjectListItem[]>(response);
}

/** Get a single project with clips and jobs. */
export async function getProject(projectId: string): Promise<Project> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}`);
  return handleResponse<Project>(response);
}

/** Update project name or status. */
export async function updateProject(
  projectId: string,
  data: { name?: string; status?: string }
): Promise<Project> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
  return handleResponse<Project>(response);
}

// --- Export endpoints ---

export interface ExportStatus {
  export_id: string;
  status: "pending" | "rendering" | "completed" | "failed";
  progress: string | null;
  download_url: string | null;
  error: string | null;
}

// --- Speech endpoints ---

export interface RenderChunkResponse {
  chunk_id: string;
  text: string;
  voice: string;
  speaking_rate: number;
  gcs_url: string;
  audio_duration: number;
}

/** Render a single speech chunk (or preview voice). */
export async function renderSpeechChunk(
  projectId: string,
  chunkId: string,
  text: string,
  voice: string,
  speakingRate: number,
): Promise<RenderChunkResponse> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/speech/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chunk_id: chunkId,
      text,
      voice,
      speaking_rate: speakingRate,
    }),
  });
  return handleResponse<RenderChunkResponse>(response);
}

/** Start an export job for a proposal. */
export async function startExport(
  projectId: string,
  proposal: Record<string, unknown>,
  jobId?: string,
  proposalIndex?: number,
): Promise<ExportStatus> {
  const body: Record<string, unknown> = {
    proposal,
    proposal_index: proposalIndex ?? 0,
  };
  if (jobId) {
    body.job_id = jobId;
  }

  const response = await fetch(`${BASE_URL}/projects/${projectId}/export`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<ExportStatus>(response);
}

/** Get export job status. */
export async function getExportStatus(
  projectId: string,
  exportId: string
): Promise<ExportStatus> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/export/${exportId}`);
  return handleResponse<ExportStatus>(response);
}

export { ApiError };

// --- Music endpoints ---

export interface MusicTrackResult {
  id: string;
  name: string;
  artist_name: string;
  duration: number;
  audio: string;
  tags: string[];
}

export interface MusicRefineResponse {
  status: string;
  music: Record<string, unknown>;
}

/** Refine music selection via agent feedback. */
export async function refineMusicSelection(
  projectId: string,
  proposalIndex: number,
  feedback: string,
  currentMusic: Record<string, unknown> | null,
  jobId?: string,
): Promise<MusicRefineResponse> {
  const body: Record<string, unknown> = {
    proposal_index: proposalIndex,
    feedback,
    current_music: currentMusic,
  };
  if (jobId) {
    body.job_id = jobId;
  }

  const response = await fetch(`${BASE_URL}/projects/${projectId}/music/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return handleResponse<MusicRefineResponse>(response);
}

/** Search Jamendo directly for music tracks. */
export async function searchMusicTracks(
  projectId: string,
  query: string,
): Promise<MusicTrackResult[]> {
  const response = await fetch(`${BASE_URL}/projects/${projectId}/music/search`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query }),
  });
  return handleResponse<MusicTrackResult[]>(response);
}


