import { useEffect, useRef, useState } from "react";
import type { JobStatus } from "../types";
import { getJob } from "../services/api";

const POLL_INTERVAL_MS = 3000;

interface UseJobPollingResult {
  job: JobStatus | null;
  error: string | null;
}

export function useJobPolling(jobId: string | null): UseJobPollingResult {
  const [job, setJob] = useState<JobStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!jobId) return;

    let active = true;

    const poll = async () => {
      try {
        const result = await getJob(jobId);
        if (!active) return;
        setJob(result);
        setError(null);

        // Stop polling on terminal states
        if (result.status === "completed" || result.status === "failed") {
          if (intervalRef.current) {
            clearInterval(intervalRef.current);
            intervalRef.current = null;
          }
        }
      } catch (e: unknown) {
        if (!active) return;
        // Silently ignore transient network errors during polling.
        // Only surface errors if we've never gotten a successful response.
        if (!job) {
          const msg = e instanceof Error ? e.message : "Polling failed";
          setError(msg);
        }
        // Otherwise just skip this poll cycle -- next one will retry.
      }
    };

    // Initial fetch immediately
    poll();

    // Then poll on interval
    intervalRef.current = setInterval(poll, POLL_INTERVAL_MS);

    return () => {
      active = false;
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [jobId]);

  return { job, error };
}
