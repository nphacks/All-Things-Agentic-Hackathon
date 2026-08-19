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
  jobId?: string
): Promise<ClipMetadata[]> {
  const formData = new FormData();
  for (const file of files) {
    formData.append("files", file);
  }
  if (jobId) {
    formData.append("job_id", jobId);
  }

  const response = await fetch(`${BASE_URL}/clips/upload`, {
    method: "POST",
    body: formData,
  });
  return handleResponse<ClipMetadata[]>(response);
}

/** Create a new editing job. Returns immediately with job_id. */
export async function createJob(
  brief: string,
  clipIds: string[],
  settings: JobSettings
): Promise<JobCreateResponse> {
  const response = await fetch(`${BASE_URL}/jobs/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      brief,
      clip_ids: clipIds,
      settings,
    }),
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

export { ApiError };
