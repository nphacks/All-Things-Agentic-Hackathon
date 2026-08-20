import { useEffect, useMemo, useRef, useState } from "react";
import type { JobStatus, Proposal, Transition, Filter } from "../types";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import { startExport, getExportStatus, saveProposals } from "../services/api";
import type { ExportStatus } from "../services/api";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

interface EditorViewProps {
  job: JobStatus;
  onNewEdit: () => void;
  projectId?: string;
}

export default function EditorView({ job, onNewEdit, projectId }: EditorViewProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);

  // Local mutable proposals state (for editing transitions/filters)
  const [proposals, setProposals] = useState<Proposal[]>(job.proposals);
  const selectedProposal = proposals[selectedIdx] || null;

  // Auto-save proposals to Firestore when edited (debounced)
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const initialLoadRef = useRef(true);

  useEffect(() => {
    // Skip first render (initial load)
    if (initialLoadRef.current) {
      initialLoadRef.current = false;
      return;
    }

    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => {
      saveProposals(job.job_id, proposals as unknown as Record<string, unknown>[]).catch(() => {});
    }, 1000);

    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    };
  }, [proposals, job.job_id]);

  // Export state
  const [exportStatus, setExportStatus] = useState<Record<number, ExportStatus>>({});
  const [exportingIdx, setExportingIdx] = useState<number | null>(null);

  // Trigger file download from URL
  const downloadFile = async (url: string, filename: string) => {
    try {
      const response = await fetch(url);
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(blobUrl);
    } catch {
      // Fallback: open in new tab
      window.open(url, "_blank");
    }
  };

  // Poll export status
  useEffect(() => {
    if (exportingIdx === null || !projectId) return;
    const status = exportStatus[exportingIdx];
    if (!status || status.status === "completed" || status.status === "failed") return;

    const interval = setInterval(async () => {
      try {
        const updated = await getExportStatus(projectId, status.export_id);
        setExportStatus((prev) => ({ ...prev, [exportingIdx]: updated }));
        if (updated.status === "completed") {
          setExportingIdx(null);
          // Auto-download
          if (updated.download_url) {
            downloadFile(updated.download_url, `${proposals[exportingIdx]?.label || "export"}.mp4`);
          }
        } else if (updated.status === "failed") {
          setExportingIdx(null);
        }
      } catch {
        // Ignore poll errors
      }
    }, 3000);

    return () => clearInterval(interval);
  }, [exportingIdx, exportStatus, projectId]);

  const handleExport = async (idx: number) => {
    if (!projectId) return;
    try {
      const result = await startExport(
        projectId,
        proposals[idx] as unknown as Record<string, unknown>,
        job.job_id,
        idx,
      );
      setExportStatus((prev) => ({ ...prev, [idx]: result }));
      // If cached (already exported, no changes), trigger download immediately
      if (result.status === "completed" && result.download_url) {
        downloadFile(result.download_url, `${proposals[idx].label || "export"}.mp4`);
      } else {
        setExportingIdx(idx);
      }
    } catch {
      // Error starting export
    }
  };

  // Handler for transition changes
  const handleTransitionChange = (proposalIdx: number, segmentIdx: number, transition: Transition) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      const timeline = [...proposal.timeline];
      timeline[segmentIdx] = { ...timeline[segmentIdx], transition };
      proposal.timeline = timeline;
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Handler for filter changes
  const handleFilterChange = (proposalIdx: number, segmentIdx: number, filter: Filter) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      const timeline = [...proposal.timeline];
      timeline[segmentIdx] = { ...timeline[segmentIdx], filter };
      proposal.timeline = timeline;
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Handler for brightness changes
  const handleBrightnessChange = (proposalIdx: number, segmentIdx: number, brightness: number) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      const timeline = [...proposal.timeline];
      timeline[segmentIdx] = { ...timeline[segmentIdx], brightness_adjustment: brightness };
      proposal.timeline = timeline;
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Build clip URL map from job data
  const clipUrls = useMemo(() => {
    const map: Record<string, string> = {};
    for (let i = 0; i < job.clips.length; i++) {
      const clip = job.clips[i];
      // Use GCS URL if available, otherwise fall back to local /media/ endpoint
      let mediaUrl: string;
      if (clip.gcs_url) {
        mediaUrl = clip.gcs_url;
      } else {
        const relativePath = clip.file_path.replace(/^uploads\//, "");
        mediaUrl = `${API_URL}/media/${relativePath}`;
      }

      map[clip.file_path] = mediaUrl;
      map[clip.clip_id] = mediaUrl;
      map[clip.filename] = mediaUrl;
      if (!clip.gcs_url) {
        const relativePath = clip.file_path.replace(/^uploads\//, "");
        map[`uploads/${relativePath}`] = mediaUrl;
      }
      map[`clip_${i}`] = mediaUrl;
      map[`clip_${i + 1}`] = mediaUrl;
      const noExt = clip.filename.replace(/\.\w+$/, "");
      map[noExt] = mediaUrl;
      map[noExt.replace(/-/g, "_")] = mediaUrl;
    }
    return map;
  }, [job.clips]);

  // Get unique media URLs for thumbnail capture -- no longer needed, filmstrip handles it

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] overflow-hidden">
      {/* Top: Video player (50%) -- no scroll */}
      <div className="h-[50%] shrink-0 px-6 pt-2 pb-2 flex items-center justify-center">
        <div className="w-full max-w-3xl h-full">
          <VideoPlayer
            proposal={selectedProposal}
            clipUrls={clipUrls}
            onTimeUpdate={setCurrentTime}
            playheadRef={playheadRef}
          />
        </div>
      </div>

      {/* Bottom: Timelines (50%) -- independently scrollable */}
      <div className="h-[50%] overflow-y-auto overflow-x-visible px-6 pb-4 border-t border-white/5">
        <div className="flex items-center justify-between py-2 sticky top-0 z-10 bg-dark-500/80 backdrop-blur-sm">
          <h3 className="text-base font-medium text-white/60">
            Proposals ({proposals.length})
          </h3>
          <button
            onClick={onNewEdit}
            className="text-sm text-white/40 hover:text-white/70 px-3 py-1 rounded-lg border border-white/10 hover:border-white/20"
          >
            New Edit
          </button>
        </div>

        <div className="space-y-3">
          {proposals.map((proposal, i) => (
            <div key={i} className="space-y-1">
              <Timeline
                proposal={proposal}
                currentTime={i === selectedIdx ? currentTime : 0}
                totalDuration={proposal.total_duration}
                isActive={i === selectedIdx}
                onClick={() => {
                  setSelectedIdx(i);
                  setCurrentTime(0);
                }}
                clipUrls={clipUrls}
                playheadRef={i === selectedIdx ? playheadRef : undefined}
                onTransitionChange={(segIdx, transition) => handleTransitionChange(i, segIdx, transition)}
                onFilterChange={(segIdx, filter) => handleFilterChange(i, segIdx, filter)}
                onBrightnessChange={(segIdx, brightness) => handleBrightnessChange(i, segIdx, brightness)}
              />

              {/* Reasoning (shown for active proposal) */}
              {i === selectedIdx && (
                <div className="px-3 py-2 space-y-1">
                  <p className="text-xs text-white/50 leading-relaxed">
                    {proposal.reasoning}
                  </p>
                  {proposal.clips_not_used.length > 0 && (
                    <p className="text-xs text-white/30">
                      Clips skipped: {proposal.clips_not_used.length} --{" "}
                      {proposal.clips_not_used_reason}
                    </p>
                  )}
                  {/* Export button */}
                  {projectId && (
                    <div className="mt-2">
                      {exportStatus[i]?.status === "completed" && exportStatus[i]?.download_url ? (
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            downloadFile(exportStatus[i].download_url!, `${proposal.label || "export"}.mp4`);
                          }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-400/30 text-green-400 text-xs font-medium hover:bg-green-500/30 transition-all"
                        >
                          Download MP4
                        </button>
                      ) : exportStatus[i]?.status === "rendering" || exportStatus[i]?.status === "pending" ? (
                        <div className="flex items-center gap-2">
                          <div className="flex-1 h-1.5 rounded-full bg-dark-300 overflow-hidden max-w-[200px]">
                            <div className="h-full bg-green-400 rounded-full transition-all duration-1000" style={{ width: "100%", animation: "progress-indeterminate 2s ease-in-out infinite" }} />
                          </div>
                          <span className="text-[10px] text-white/40">Exporting...</span>
                        </div>
                      ) : exportStatus[i]?.status === "failed" ? (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExport(i); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-400/20 text-red-400 text-xs"
                          title={exportStatus[i]?.error || ""}
                        >
                          Retry Export
                        </button>
                      ) : (
                        <button
                          onClick={(e) => { e.stopPropagation(); handleExport(i); }}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-300 border border-white/10 text-white/50 text-xs font-medium hover:border-green-400/30 hover:text-green-400 transition-all"
                        >
                          Export MP4
                        </button>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
