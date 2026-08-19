import { useMemo, useRef, useState } from "react";
import type { JobStatus } from "../types";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import { useThumbnails } from "../hooks/useThumbnails";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

interface EditorViewProps {
  job: JobStatus;
  onNewEdit: () => void;
}

export default function EditorView({ job, onNewEdit }: EditorViewProps) {
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const playheadRef = useRef<HTMLDivElement>(null);

  const proposals = job.proposals;
  const selectedProposal = proposals[selectedIdx] || null;

  // Build clip URL map from job data
  const clipUrls = useMemo(() => {
    const map: Record<string, string> = {};
    for (let i = 0; i < job.clips.length; i++) {
      const clip = job.clips[i];
      const relativePath = clip.file_path.replace(/^uploads\//, "");
      const mediaUrl = `${API_URL}/media/${relativePath}`;

      map[clip.file_path] = mediaUrl;
      map[clip.clip_id] = mediaUrl;
      map[clip.filename] = mediaUrl;
      map[`uploads/${relativePath}`] = mediaUrl;
      map[`clip_${i}`] = mediaUrl;
      map[`clip_${i + 1}`] = mediaUrl;
      const noExt = clip.filename.replace(/\.\w+$/, "");
      map[noExt] = mediaUrl;
      map[noExt.replace(/-/g, "_")] = mediaUrl;
    }
    return map;
  }, [job.clips]);

  // Get unique media URLs for thumbnail capture
  const uniqueMediaUrls = useMemo(() => {
    const urls = new Set<string>();
    for (const clip of job.clips) {
      const relativePath = clip.file_path.replace(/^uploads\//, "");
      urls.add(`${API_URL}/media/${relativePath}`);
    }
    return Array.from(urls);
  }, [job.clips]);

  const thumbnails = useThumbnails(uniqueMediaUrls);

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
      <div className="h-[50%] overflow-y-auto px-6 pb-4 border-t border-white/5">
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
                thumbnails={thumbnails}
                clipUrls={clipUrls}
                playheadRef={i === selectedIdx ? playheadRef : undefined}
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
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
