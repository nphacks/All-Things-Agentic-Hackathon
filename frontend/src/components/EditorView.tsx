import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import type { JobStatus, Proposal, Transition, Filter, TextOverlay } from "../types";
import VideoPlayer from "./VideoPlayer";
import Timeline from "./Timeline";
import AudioTracks from "./AudioTracks";
import type { AudioTrackState, SpeechChunk } from "./AudioTracks";
import type { MusicSelection } from "./MusicPanel";
import EditLogPanel from "./EditLogPanel";
import { startExport, getExportStatus, saveProposals } from "../services/api";
import type { ExportStatus } from "../services/api";
import { computeDuckingKeyframes } from "../utils/ducking";
import useAudioPlayback from "../hooks/useAudioPlayback";

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

  // Audio track state
  const [audioTrackState, setAudioTrackState] = useState<AudioTrackState>({
    originalMuted: false,
    originalVolume: 0.8,
    speechMuted: false,
    speechVolume: 1.0,
    musicMuted: false,
    musicVolume: 0.5,
  });

  // Playback state for audio sync
  const [videoIsPlaying, setVideoIsPlaying] = useState(false);
  const [videoVolume, setVideoVolume] = useState<number>(0.8);

  // Bottom drawer (proposal switcher + edit log)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerTab, setDrawerTab] = useState<"proposals" | "log">("proposals");

  // Audio playback hook (3-layer mixing)
  const playbackSpeechChunks = useMemo((): SpeechChunk[] => {
    if (!selectedProposal) return [];
    const p = selectedProposal as unknown as Record<string, unknown>;
    return Array.isArray(p.speech) ? (p.speech as SpeechChunk[]) : [];
  }, [selectedProposal]);

  const playbackMusic = useMemo((): MusicSelection | null => {
    if (!selectedProposal) return null;
    const p = selectedProposal as unknown as Record<string, unknown>;
    return (p.music && typeof p.music === "object") ? (p.music as unknown as MusicSelection) : null;
  }, [selectedProposal]);

  const playbackKeyframes = useMemo(() => {
    if (!selectedProposal) return [];
    for (const seg of selectedProposal.timeline) {
      if (seg.audio?.keyframes?.length) return seg.audio.keyframes;
    }
    return [];
  }, [selectedProposal]);

  useAudioPlayback({
    currentTime,
    isPlaying: videoIsPlaying,
    totalDuration: selectedProposal?.total_duration ?? 0,
    speechChunks: playbackSpeechChunks,
    music: playbackMusic,
    originalKeyframes: playbackKeyframes,
    trackState: audioTrackState,
    onSetVideoVolume: useCallback((vol: number) => setVideoVolume(vol), []),
  });

  // Handler for music change from MusicPanel
  const handleMusicChange = (proposalIdx: number, newMusic: MusicSelection) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      (proposal as unknown as Record<string, unknown>).music = newMusic;
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Handler for speech chunks change (edit, add, delete, reposition)
  const handleSpeechChunksChange = (proposalIdx: number, chunks: SpeechChunk[]) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      const p = proposal as unknown as Record<string, unknown>;
      p.speech = chunks;

      // Auto-ducking: recalculate music volume keyframes only when auto-duck is on.
      // auto_duck defaults to true when unset.
      const music = p.music as Record<string, unknown> | undefined;
      const autoDuck = music ? (music.auto_duck === undefined ? true : music.auto_duck) : true;
      if (music && autoDuck) {
        const duration = proposal.total_duration;
        const newKeyframes = computeDuckingKeyframes(duration, chunks);
        music.volume_keyframes = newKeyframes;
      }

      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Read auto-duck flag for a proposal's music (defaults to true)
  const getAutoDuck = (proposal: Proposal): boolean => {
    const p = proposal as unknown as Record<string, unknown>;
    const music = p.music as Record<string, unknown> | undefined;
    if (!music) return true;
    return music.auto_duck === undefined ? true : (music.auto_duck as boolean);
  };

  // Toggle auto-duck for a proposal's music
  const handleAutoDuckChange = (proposalIdx: number, enabled: boolean) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      const p = proposal as unknown as Record<string, unknown>;
      const music = p.music as Record<string, unknown> | undefined;
      if (music) {
        music.auto_duck = enabled;
        // When turning auto-duck back on, immediately recompute keyframes
        if (enabled) {
          const chunks = Array.isArray(p.speech) ? (p.speech as SpeechChunk[]) : [];
          music.volume_keyframes = computeDuckingKeyframes(proposal.total_duration, chunks);
        }
      }
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

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

  // Handler for text overlay changes (edit, add, delete)
  const handleTextOverlaysChange = (proposalIdx: number, overlays: TextOverlay[]) => {
    setProposals((prev) => {
      const updated = [...prev];
      const proposal = { ...updated[proposalIdx] };
      proposal.text_overlays = overlays;
      updated[proposalIdx] = proposal;
      return updated;
    });
  };

  // Helper: extract text overlays from proposal
  const getTextOverlays = (proposal: Proposal): TextOverlay[] => {
    return Array.isArray(proposal.text_overlays) ? proposal.text_overlays : [];
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

  // Helper: extract combined waveform data for a proposal (merge waveforms from used clips)
  const getWaveformForProposal = (): number[] => {
    // Use the first clip's waveform or combine them based on timeline
    const analyses = job.clip_analyses || {};
    for (const key of Object.keys(analyses)) {
      const analysis = analyses[key] as unknown as Record<string, unknown>;
      if (analysis && Array.isArray(analysis.waveform)) {
        return analysis.waveform as number[];
      }
    }
    return [];
  };

  // Helper: extract speech chunks from proposal
  const getSpeechChunks = (proposal: Proposal): SpeechChunk[] => {
    const p = proposal as unknown as Record<string, unknown>;
    if (Array.isArray(p.speech)) {
      return p.speech as SpeechChunk[];
    }
    return [];
  };

  // Helper: extract music selection from proposal
  const getMusicSelection = (proposal: Proposal): MusicSelection | null => {
    const p = proposal as unknown as Record<string, unknown>;
    if (p.music && typeof p.music === "object") {
      return p.music as unknown as MusicSelection;
    }
    return null;
  };

  return (
    <div className="flex flex-col h-[calc(100vh-5rem)] overflow-hidden">
      {/* Row 1: Video player */}
      <div className="h-[50%] shrink-0 px-6 pt-2 pb-2 flex items-center justify-center">
        <div className="w-full max-w-3xl h-full">
          <VideoPlayer
            proposal={selectedProposal}
            clipUrls={clipUrls}
            onTimeUpdate={setCurrentTime}
            onPlayStateChange={setVideoIsPlaying}
            videoVolume={videoVolume}
            playheadRef={playheadRef}
          />
        </div>
      </div>

      {/* Row 2: Unified timeline (filmstrip + audio lanes) */}
      <div className="h-[50%] min-h-0 overflow-y-auto px-6 pb-4 border-t border-white/5">
        {/* Reasoning above the timeline */}
        {selectedProposal && (
          <div className="pt-2 pb-1 px-1">
            <p className="text-[11px] text-white/50 leading-relaxed line-clamp-2">
              {selectedProposal.reasoning}
            </p>
            {selectedProposal.clips_not_used.length > 0 && (
              <p className="text-[10px] text-white/30 mt-0.5 line-clamp-1">
                Clips skipped: {selectedProposal.clips_not_used.length} -- {selectedProposal.clips_not_used_reason}
              </p>
            )}
          </div>
        )}

        {/* Unified timeline: filmstrip + audio lanes, one scale + one playhead */}
        {selectedProposal && (
          <AudioTracks
            totalDuration={selectedProposal.total_duration}
            currentTime={currentTime}
            waveformData={getWaveformForProposal()}
            speechChunks={getSpeechChunks(selectedProposal)}
            music={getMusicSelection(selectedProposal)}
            trackState={audioTrackState}
            onTrackStateChange={setAudioTrackState}
            onMusicChange={(m) => handleMusicChange(selectedIdx, m)}
            onSpeechChunksChange={(chunks) => handleSpeechChunksChange(selectedIdx, chunks)}
            autoDuck={getAutoDuck(selectedProposal)}
            onAutoDuckChange={(enabled) => handleAutoDuckChange(selectedIdx, enabled)}
            projectId={projectId}
            jobId={job.job_id}
            proposalIndex={selectedIdx}
            voiceName={(job as unknown as Record<string, unknown>).settings
              ? ((job as unknown as Record<string, unknown>).settings as Record<string, unknown>).voice_name as string || "en-US-Journey-D"
              : "en-US-Journey-D"}
            isActive={true}
            proposal={selectedProposal}
            clipUrls={clipUrls}
            onTransitionChange={(segIdx, transition) => handleTransitionChange(selectedIdx, segIdx, transition)}
            onFilterChange={(segIdx, filter) => handleFilterChange(selectedIdx, segIdx, filter)}
            onBrightnessChange={(segIdx, brightness) => handleBrightnessChange(selectedIdx, segIdx, brightness)}
            textOverlays={getTextOverlays(selectedProposal)}
            onTextOverlaysChange={(overlays) => handleTextOverlaysChange(selectedIdx, overlays)}
          />
        )}
      </div>

      {/* Bottom bar: open drawer + new edit + export */}
      <div className="shrink-0 flex items-center gap-3 px-6 py-2 border-t border-white/10 bg-dark-600/60 backdrop-blur-sm">
        <button
          onClick={() => setDrawerOpen(true)}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-dark-300 border border-white/10 text-white/70 text-xs font-medium hover:border-green-400/30 hover:text-green-400 transition-all"
        >
          <span className="text-[10px]">^</span>
          Proposals ({proposals.length}) -- editing #{selectedIdx + 1}
        </button>

        {/* Export button */}
        {projectId && selectedProposal && (
          exportStatus[selectedIdx]?.status === "completed" && exportStatus[selectedIdx]?.download_url ? (
            <button
              onClick={() => downloadFile(exportStatus[selectedIdx].download_url!, `${selectedProposal.label || "export"}.mp4`)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-green-500/20 border border-green-400/30 text-green-400 text-xs font-medium hover:bg-green-500/30 transition-all"
            >
              Download MP4
            </button>
          ) : exportStatus[selectedIdx]?.status === "rendering" || exportStatus[selectedIdx]?.status === "pending" ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 rounded-full bg-dark-300 overflow-hidden w-[120px]">
                <div className="h-full bg-green-400 rounded-full" style={{ width: "100%", animation: "progress-indeterminate 2s ease-in-out infinite" }} />
              </div>
              <span className="text-[10px] text-white/40">Exporting...</span>
            </div>
          ) : exportStatus[selectedIdx]?.status === "failed" ? (
            <button
              onClick={() => handleExport(selectedIdx)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-red-500/10 border border-red-400/20 text-red-400 text-xs"
              title={exportStatus[selectedIdx]?.error || ""}
            >
              Retry Export
            </button>
          ) : (
            <button
              onClick={() => handleExport(selectedIdx)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-dark-300 border border-white/10 text-white/50 text-xs font-medium hover:border-green-400/30 hover:text-green-400 transition-all"
            >
              Export MP4
            </button>
          )
        )}

        <button
          onClick={onNewEdit}
          className="ml-auto text-xs text-white/40 hover:text-white/70 px-3 py-1.5 rounded-lg border border-white/10 hover:border-white/20"
        >
          New Edit
        </button>
      </div>

      {/* Slide-up drawer: proposal switcher + edit log */}
      {/* Backdrop */}
      <div
        className={`fixed inset-0 z-[300] bg-black/40 transition-opacity duration-300 ${
          drawerOpen ? "opacity-100" : "opacity-0 pointer-events-none"
        }`}
        onClick={() => setDrawerOpen(false)}
      />
      {/* Panel */}
      <div
        className={`fixed left-0 right-0 bottom-0 z-[301] glass-strong border-t border-white/10 rounded-t-2xl transition-transform duration-300 ease-out ${
          drawerOpen ? "translate-y-0" : "translate-y-full"
        }`}
        style={{ maxHeight: "70vh" }}
      >
        <div className="flex items-center justify-between px-6 py-3 border-b border-white/5">
          {/* Tabs */}
          <div className="flex gap-1">
            <button
              onClick={() => setDrawerTab("proposals")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                drawerTab === "proposals"
                  ? "bg-green-500/20 text-green-400 border border-green-500/40"
                  : "text-white/40 hover:text-white/70 border border-transparent"
              }`}
            >
              Proposals ({proposals.length})
            </button>
            <button
              onClick={() => setDrawerTab("log")}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                drawerTab === "log"
                  ? "bg-green-500/20 text-green-400 border border-green-500/40"
                  : "text-white/40 hover:text-white/70 border border-transparent"
              }`}
            >
              Agent Log
            </button>
          </div>
          <button
            onClick={() => setDrawerOpen(false)}
            className="w-6 h-6 flex items-center justify-center rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-all"
            aria-label="Close drawer"
          >
            x
          </button>
        </div>

        <div className="overflow-y-auto px-6 py-4" style={{ maxHeight: "calc(70vh - 52px)" }}>
          {/* Proposals tab */}
          {drawerTab === "proposals" && (
            <div className="space-y-3">
              {proposals.map((proposal, i) => (
                <Timeline
                  key={i}
                  proposal={proposal}
                  currentTime={0}
                  totalDuration={proposal.total_duration}
                  isActive={i === selectedIdx}
                  showPlayhead={false}
                  onClick={() => {
                    setSelectedIdx(i);
                    setCurrentTime(0);
                    setDrawerOpen(false);
                  }}
                  clipUrls={clipUrls}
                  onTransitionChange={(segIdx, transition) => handleTransitionChange(i, segIdx, transition)}
                  onFilterChange={(segIdx, filter) => handleFilterChange(i, segIdx, filter)}
                  onBrightnessChange={(segIdx, brightness) => handleBrightnessChange(i, segIdx, brightness)}
                />
              ))}
            </div>
          )}

          {/* Agent Log tab */}
          {drawerTab === "log" && (
            job.edit_log && job.edit_log.length > 0 ? (
              <EditLogPanel entries={job.edit_log ?? []} defaultExpanded />
            ) : (
              <p className="text-xs text-white/30 text-center py-8">
                No agent log available for this edit.
              </p>
            )
          )}
        </div>
      </div>
    </div>
  );
}
