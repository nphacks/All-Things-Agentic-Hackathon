import { useState, useRef, useCallback, useEffect } from "react";
import { createPortal } from "react-dom";
import type { Proposal, Transition, Filter } from "../types";
import Timeline from "./Timeline";
import MusicPanel from "./MusicPanel";
import type { MusicSelection, MusicTrack } from "./MusicPanel";
import SpeechEditPanel from "./SpeechEditPanel";
import { refineMusicSelection, searchMusicTracks, renderSpeechChunk } from "../services/api";

/** Speech chunk data from the proposal */
export interface SpeechChunk {
  chunk_id: string;
  text: string;
  start_time: number;
  end_time: number;
  audio_duration?: number;
  gcs_url?: string;
  speaking_rate?: number;
}

/** Audio track volume/mute state */
export interface AudioTrackState {
  originalMuted: boolean;
  originalVolume: number;
  speechMuted: boolean;
  speechVolume: number;
  musicMuted: boolean;
  musicVolume: number;
}

interface AudioTracksProps {
  totalDuration: number;
  currentTime: number;
  waveformData: number[];
  speechChunks: SpeechChunk[];
  music: MusicSelection | null;
  trackState: AudioTrackState;
  onTrackStateChange: (state: AudioTrackState) => void;
  onMusicChange?: (music: MusicSelection) => void;
  onSpeechChunkClick?: (chunk: SpeechChunk) => void;
  onSpeechChunksChange?: (chunks: SpeechChunk[]) => void;
  autoDuck?: boolean;
  onAutoDuckChange?: (enabled: boolean) => void;
  projectId?: string;
  jobId?: string;
  proposalIndex?: number;
  voiceName?: string;
  isActive?: boolean;
  // Video lane (filmstrip) integration -- renders the selected proposal's
  // filmstrip as the top lane, sharing the same time scale and scroll.
  proposal?: Proposal;
  clipUrls?: Record<string, string>;
  onTransitionChange?: (segmentIndex: number, transition: Transition) => void;
  onFilterChange?: (segmentIndex: number, filter: Filter) => void;
  onBrightnessChange?: (segmentIndex: number, brightness: number) => void;
}

/** Render waveform as SVG bars */
function Waveform({ data, totalDuration, currentTime }: { data: number[]; totalDuration: number; currentTime: number }) {
  if (!data || data.length === 0) {
    return <div className="w-full h-full bg-dark-400 rounded flex items-center justify-center text-[9px] text-white/20">No audio</div>;
  }

  const playedPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;

  return (
    <div className="w-full h-full relative">
      <svg
        viewBox={`0 0 ${data.length} 100`}
        preserveAspectRatio="none"
        className="w-full h-full"
      >
        {data.map((amp, i) => {
          const barHeight = Math.max(2, amp * 90);
          const y = (100 - barHeight) / 2;
          const pct = (i / data.length) * 100;
          const isPlayed = pct < playedPct;
          return (
            <rect
              key={i}
              x={i}
              y={y}
              width={0.7}
              height={barHeight}
              rx={0.3}
              fill={isPlayed ? "rgba(74, 222, 128, 0.6)" : "rgba(255, 255, 255, 0.2)"}
            />
          );
        })}
      </svg>
    </div>
  );
}

/** Music volume keyframe -- editable */
interface MusicKeyframe {
  time: number;
  volume: number;
  transition?: string;
  fade_duration?: number;
}

/** Interactive volume keyframe dots for the music track */
function MusicKeyframes({
  keyframes,
  totalDuration,
  editable,
  onSelect,
}: {
  keyframes: MusicKeyframe[];
  totalDuration: number;
  editable: boolean;
  onSelect: (index: number, clientX: number, clientY: number) => void;
}) {
  if (!keyframes || keyframes.length === 0) return null;

  return (
    <>
      {keyframes.map((kf, i) => {
        const leftPct = totalDuration > 0 ? (kf.time / totalDuration) * 100 : 0;
        if (leftPct < 0 || leftPct > 100) return null;
        // Vertical position reflects volume (higher volume = higher dot)
        const topPct = 85 - kf.volume * 70;
        return (
          <button
            key={i}
            type="button"
            onClick={(e) => {
              if (!editable) return;
              e.stopPropagation();
              onSelect(i, e.clientX, e.clientY);
            }}
            className={`absolute rounded-full transition-all ${
              editable
                ? "w-2.5 h-2.5 bg-gold-400 hover:bg-gold-300 hover:scale-125 cursor-pointer border border-gold-200/50"
                : "w-1.5 h-1.5 bg-gold-400/60 pointer-events-none"
            }`}
            style={{ left: `${leftPct}%`, top: `${topPct}%`, transform: "translateX(-50%)" }}
            title={`${kf.time.toFixed(1)}s: volume ${Math.round(kf.volume * 100)}%`}
            aria-label={`Volume keyframe at ${kf.time.toFixed(1)} seconds`}
          />
        );
      })}
    </>
  );
}

/** Popover for editing a single music volume keyframe */
function KeyframeEditor({
  keyframe,
  position,
  onChange,
  onDelete,
  onClose,
}: {
  keyframe: MusicKeyframe;
  position: { x: number; y: number };
  onChange: (volume: number) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => document.addEventListener("mousedown", handleClickOutside), 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  const width = 180;
  const x = Math.max(8, Math.min(position.x - width / 2, window.innerWidth - width - 8));
  const y = Math.max(8, position.y - 130);

  const panel = (
    <div ref={panelRef} className="fixed z-[9999]" style={{ left: x, top: y, width }}>
      <div className="glass-strong rounded-xl p-3 shadow-2xl space-y-2">
        <div className="flex items-center justify-between">
          <span className="text-[10px] text-white/50">Keyframe @ {keyframe.time.toFixed(1)}s</span>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 text-xs" aria-label="Close">x</button>
        </div>
        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-white/40">Volume</span>
            <span className="text-[10px] text-gold-400">{Math.round(keyframe.volume * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={keyframe.volume}
            onChange={(e) => onChange(Number(e.target.value))}
            className="w-full h-1 rounded-full appearance-none bg-dark-300 accent-gold-400"
          />
        </div>
        <button
          onClick={onDelete}
          className="w-full px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] border border-red-500/20 hover:bg-red-500/20 transition-all"
        >
          Delete Keyframe
        </button>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}


/** Track label + controls on the left side */
function TrackLabel({
  label,
  icon,
  muted,
  volume,
  onMuteToggle,
  onVolumeChange,
}: {
  label: string;
  icon: string;
  muted: boolean;
  volume: number;
  onMuteToggle: () => void;
  onVolumeChange: (v: number) => void;
}) {
  return (
    <div className="w-[120px] flex-shrink-0 flex flex-col justify-center gap-1 pr-2 border-r border-white/5">
      <div className="flex items-center gap-1.5">
        <span className="text-[10px] text-white/30 w-4 text-center">{icon}</span>
        <span className="text-[10px] text-white/50 truncate">{label}</span>
      </div>
      <div className="flex items-center gap-1.5 pl-5">
        <button
          onClick={onMuteToggle}
          className={`text-[9px] px-1.5 py-0.5 rounded transition-all ${
            muted
              ? "bg-red-500/20 text-red-400 border border-red-500/30"
              : "bg-dark-300 text-white/40 border border-white/10 hover:border-white/20"
          }`}
          aria-label={`${muted ? "Unmute" : "Mute"} ${label}`}
        >
          {muted ? "M" : "S"}
        </button>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={muted ? 0 : volume}
          onChange={(e) => onVolumeChange(Number(e.target.value))}
          className="w-14 h-1 rounded-full appearance-none bg-dark-300 accent-green-400"
          aria-label={`${label} volume`}
        />
      </div>
    </div>
  );
}

export default function AudioTracks({
  totalDuration,
  currentTime,
  waveformData,
  speechChunks,
  music,
  trackState,
  onTrackStateChange,
  onMusicChange,
  onSpeechChunkClick,
  onSpeechChunksChange,
  autoDuck = true,
  onAutoDuckChange,
  projectId,
  jobId,
  proposalIndex,
  voiceName = "en-US-Journey-D",
  isActive = true,
  proposal,
  clipUrls,
  onTransitionChange,
  onFilterChange,
  onBrightnessChange,
}: AudioTracksProps) {
  const [musicPanelOpen, setMusicPanelOpen] = useState(false);
  const [isRefining, setIsRefining] = useState(false);
  const musicTriggerRef = useRef<HTMLButtonElement>(null);
  const [triggerRect, setTriggerRect] = useState<DOMRect | null>(null);

  // Speech editing state
  const [editingChunk, setEditingChunk] = useState<SpeechChunk | null>(null);
  const [editPanelPos, setEditPanelPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [addingChunk, setAddingChunk] = useState<{ time: number; x: number; y: number } | null>(null);
  const [newChunkText, setNewChunkText] = useState("");
  const [isAddingRendering, setIsAddingRendering] = useState(false);
  const speechTrackRef = useRef<HTMLDivElement>(null);

  // Music keyframe editing state
  const [editingKfIndex, setEditingKfIndex] = useState<number | null>(null);
  const [kfEditorPos, setKfEditorPos] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const musicTrackRef = useRef<HTMLDivElement>(null);

  // Drag state for speech chunks
  const dragRef = useRef<{ chunkId: string; startX: number; startTime: number } | null>(null);
  const [dragDelta, setDragDelta] = useState<{ chunkId: string; deltaPct: number } | null>(null);

  // Fixed time scale: 20 seconds fills the visible track area; longer scrolls.
  const scrollViewportRef = useRef<HTMLDivElement>(null);
  const [viewportWidth, setViewportWidth] = useState(0);

  useEffect(() => {
    const el = scrollViewportRef.current;
    if (!el) return;
    const measure = () => setViewportWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const VISIBLE_SECONDS = 20;
  const pxPerSec = viewportWidth > 0 ? viewportWidth / VISIBLE_SECONDS : 0;
  // Inner track content width: fills viewport for <=20s, expands (scrolls) beyond.
  const trackContentWidth = pxPerSec > 0 ? Math.max(viewportWidth, totalDuration * pxPerSec) : 0;
  // Playhead position in pixels along the track content.
  const playheadLeftPx = pxPerSec > 0 ? currentTime * pxPerSec : 0;

  const updateTrackState = (partial: Partial<AudioTrackState>) => {
    onTrackStateChange({ ...trackState, ...partial });
  };

  const handleMusicClick = () => {
    if (musicTriggerRef.current) {
      setTriggerRect(musicTriggerRef.current.getBoundingClientRect());
    }
    setMusicPanelOpen(true);
  };

  // --- Speech editing handlers ---

  const handleChunkClick = (chunk: SpeechChunk, e: React.MouseEvent) => {
    e.stopPropagation();
    if (dragRef.current) return; // Don't open if dragging
    setEditingChunk(chunk);
    setEditPanelPos({ x: e.clientX, y: e.clientY });
    onSpeechChunkClick?.(chunk);
  };

  const handleChunkUpdate = (updated: SpeechChunk) => {
    const newChunks = speechChunks.map((c) =>
      c.chunk_id === updated.chunk_id ? updated : c
    );
    onSpeechChunksChange?.(newChunks);
    setEditingChunk(null);
  };

  const handleChunkDelete = (chunkId: string) => {
    const newChunks = speechChunks.filter((c) => c.chunk_id !== chunkId);
    onSpeechChunksChange?.(newChunks);
    setEditingChunk(null);
  };

  const handleSpeechTrackClick = (e: React.MouseEvent) => {
    if (!speechTrackRef.current || !isActive) return;
    // Only trigger if clicking empty space (not a chunk)
    if ((e.target as HTMLElement).closest("[data-speech-chunk]")) return;

    const rect = speechTrackRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickPct = clickX / rect.width;
    const clickTime = clickPct * totalDuration;

    setAddingChunk({ time: Math.max(0, Math.min(clickTime, totalDuration)), x: e.clientX, y: e.clientY });
    setNewChunkText("");
  };

  const handleAddChunkConfirm = async () => {
    if (!addingChunk || !newChunkText.trim() || !projectId) return;
    setIsAddingRendering(true);

    // Estimate duration: ~2.5 chars/sec at 1.0x rate
    const estimatedDuration = Math.max(1.5, newChunkText.trim().length / 2.5);
    const chunkId = `sp_user_${Date.now()}`;

    try {
      const result = await renderSpeechChunk(
        projectId,
        chunkId,
        newChunkText.trim(),
        voiceName,
        1.0,
      );

      const newChunk: SpeechChunk = {
        chunk_id: chunkId,
        text: newChunkText.trim(),
        start_time: addingChunk.time,
        end_time: addingChunk.time + result.audio_duration,
        audio_duration: result.audio_duration,
        gcs_url: result.gcs_url,
        speaking_rate: 1.0,
      };

      onSpeechChunksChange?.([...speechChunks, newChunk]);
    } catch {
      // Still add the chunk with estimated duration even if render fails
      const newChunk: SpeechChunk = {
        chunk_id: chunkId,
        text: newChunkText.trim(),
        start_time: addingChunk.time,
        end_time: addingChunk.time + estimatedDuration,
        speaking_rate: 1.0,
      };
      onSpeechChunksChange?.([...speechChunks, newChunk]);
    } finally {
      setIsAddingRendering(false);
      setAddingChunk(null);
    }
  };

  // --- Drag handlers for speech chunks ---

  const handleChunkDragStart = (chunkId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const chunk = speechChunks.find((c) => c.chunk_id === chunkId);
    if (!chunk) return;
    dragRef.current = { chunkId, startX: e.clientX, startTime: chunk.start_time };
    setDragDelta(null);

    const handleMouseMove = (ev: MouseEvent) => {
      if (!dragRef.current || !speechTrackRef.current) return;
      const trackWidth = speechTrackRef.current.getBoundingClientRect().width;
      const dx = ev.clientX - dragRef.current.startX;
      const deltaPct = (dx / trackWidth) * 100;
      setDragDelta({ chunkId: dragRef.current.chunkId, deltaPct });
    };

    const handleMouseUp = (ev: MouseEvent) => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
      if (!dragRef.current || !speechTrackRef.current) {
        dragRef.current = null;
        setDragDelta(null);
        return;
      }

      const trackWidth = speechTrackRef.current.getBoundingClientRect().width;
      const dx = ev.clientX - dragRef.current.startX;
      const deltaTime = (dx / trackWidth) * totalDuration;

      // Only commit if moved more than 0.2s
      if (Math.abs(deltaTime) > 0.2) {
        const chunk = speechChunks.find((c) => c.chunk_id === dragRef.current!.chunkId);
        if (chunk) {
          const chunkDuration = chunk.end_time - chunk.start_time;
          const newStart = Math.max(0, Math.min(chunk.start_time + deltaTime, totalDuration - chunkDuration));
          const newChunks = speechChunks.map((c) =>
            c.chunk_id === dragRef.current!.chunkId
              ? { ...c, start_time: newStart, end_time: newStart + chunkDuration }
              : c
          );
          onSpeechChunksChange?.(newChunks);
        }
      }

      dragRef.current = null;
      setDragDelta(null);
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
  };

  const handleFeedbackSubmit = useCallback(async (feedback: string) => {
    if (!projectId) return;
    setIsRefining(true);
    try {
      const result = await refineMusicSelection(
        projectId,
        proposalIndex ?? 0,
        feedback,
        music as unknown as Record<string, unknown>,
        jobId,
      );
      if (result.status === "success" && result.music && onMusicChange) {
        onMusicChange(result.music as unknown as MusicSelection);
      }
    } finally {
      setIsRefining(false);
    }
  }, [projectId, proposalIndex, music, jobId, onMusicChange]);

  const handleSearchQuery = useCallback(async (query: string): Promise<MusicTrack[]> => {
    if (!projectId) return [];
    const results = await searchMusicTracks(projectId, query);
    return results.map((r) => ({
      id: r.id,
      name: r.name,
      artist_name: r.artist_name,
      duration: r.duration,
      audio: r.audio,
      tags: r.tags,
    }));
  }, [projectId]);

  const handleTrackSelect = useCallback((track: MusicTrack) => {
    if (!onMusicChange) return;
    // Convert search result to MusicSelection format
    const newMusic: MusicSelection = {
      track_id: track.id,
      title: track.name,
      artist: track.artist_name,
      url: track.audio,
      preview_url: track.audio,
      duration: track.duration,
      tags: track.tags,
      reason: "Manually selected by user",
    };
    onMusicChange(newMusic);
    setMusicPanelOpen(false);
  }, [onMusicChange]);

  // --- Music keyframe editing ---

  const musicKeyframes: MusicKeyframe[] = (music?.volume_keyframes as MusicKeyframe[] | undefined) || [];

  // Keyframes are editable only when auto-ducking is OFF (manual mode)
  const keyframesEditable = !!music && !autoDuck && !!onMusicChange;

  const commitKeyframes = (kfs: MusicKeyframe[]) => {
    if (!music || !onMusicChange) return;
    const sorted = [...kfs]
      .sort((a, b) => a.time - b.time)
      .map((kf) => ({
        time: kf.time,
        volume: kf.volume,
        transition: kf.transition ?? "fade",
        fade_duration: kf.fade_duration ?? 0.3,
      }));
    onMusicChange({ ...music, volume_keyframes: sorted });
  };

  const handleKeyframeSelect = (index: number, clientX: number, clientY: number) => {
    setEditingKfIndex(index);
    setKfEditorPos({ x: clientX, y: clientY });
  };

  const handleKeyframeVolumeChange = (volume: number) => {
    if (editingKfIndex === null) return;
    const updated = musicKeyframes.map((kf, i) =>
      i === editingKfIndex ? { ...kf, volume } : kf
    );
    commitKeyframes(updated);
  };

  const handleKeyframeDelete = () => {
    if (editingKfIndex === null) return;
    const updated = musicKeyframes.filter((_, i) => i !== editingKfIndex);
    commitKeyframes(updated);
    setEditingKfIndex(null);
  };

  const handleMusicTrackClick = (e: React.MouseEvent) => {
    // Add a new keyframe when clicking empty space (manual mode only)
    if (!keyframesEditable || !musicTrackRef.current) return;
    if ((e.target as HTMLElement).closest("[data-music-bar]")) return;

    const rect = musicTrackRef.current.getBoundingClientRect();
    const clickX = e.clientX - rect.left;
    const clickPct = Math.max(0, Math.min(clickX / rect.width, 1));
    const clickTime = clickPct * totalDuration;

    // Default volume = interpolated value at that time (or 0.5)
    let vol = 0.5;
    if (musicKeyframes.length > 0) {
      const sorted = [...musicKeyframes].sort((a, b) => a.time - b.time);
      if (clickTime <= sorted[0].time) vol = sorted[0].volume;
      else if (clickTime >= sorted[sorted.length - 1].time) vol = sorted[sorted.length - 1].volume;
      else {
        for (let i = 0; i < sorted.length - 1; i++) {
          if (clickTime >= sorted[i].time && clickTime <= sorted[i + 1].time) {
            const range = sorted[i + 1].time - sorted[i].time;
            const p = range > 0 ? (clickTime - sorted[i].time) / range : 0;
            vol = sorted[i].volume + (sorted[i + 1].volume - sorted[i].volume) * p;
            break;
          }
        }
      }
    }

    const newKf: MusicKeyframe = {
      time: Math.round(clickTime * 100) / 100,
      volume: Math.round(vol * 100) / 100,
      transition: "fade",
      fade_duration: 0.3,
    };
    commitKeyframes([...musicKeyframes, newKf]);
  };

  return (
    <div className={`rounded-xl p-3 mt-2 ${isActive ? "glass border border-green-500/20" : "glass-light"}`}>
      <div className="text-[10px] text-white/30 mb-2 uppercase tracking-wider">Audio Tracks</div>

      {/* Horizontally scrollable track region (20s fills width, more scrolls) */}
      <div ref={scrollViewportRef} className="relative overflow-x-auto overflow-y-hidden">
        <div className="relative" style={{ width: trackContentWidth ? `${trackContentWidth + 120}px` : "100%" }}>
          {/* Playhead line spanning all tracks */}
          {isActive && pxPerSec > 0 && (
            <div
              className="absolute top-0 bottom-0 w-0.5 bg-green-400/60 pointer-events-none z-20"
              style={{ left: `${120 + playheadLeftPx}px` }}
            />
          )}

          <div className="space-y-1">
            {/* Video lane (filmstrip) -- shares the same scale + playhead */}
            {proposal && pxPerSec > 0 && (
              <div className="flex items-stretch rounded-lg bg-dark-400/30">
                <div className="sticky left-0 z-10 w-[120px] flex-shrink-0 bg-dark-400/80 backdrop-blur-sm rounded-l-lg flex items-center pl-2 border-r border-white/5">
                  <span className="text-[10px] text-white/30 w-4 text-center">[V]</span>
                  <span className="text-[10px] text-white/50 truncate ml-1">Video</span>
                </div>
                <div className="px-2 py-1" style={{ width: `${trackContentWidth}px` }}>
                  <Timeline
                    proposal={proposal}
                    currentTime={currentTime}
                    totalDuration={totalDuration}
                    isActive={isActive}
                    clipUrls={clipUrls}
                    onTransitionChange={onTransitionChange}
                    onFilterChange={onFilterChange}
                    onBrightnessChange={onBrightnessChange}
                    contentWidthPx={trackContentWidth}
                    bare
                  />
                </div>
              </div>
            )}

            {/* Original Audio Track */}
            <div className="flex items-stretch h-10 rounded-lg bg-dark-400/30">
              <div className="sticky left-0 z-10 bg-dark-400/80 backdrop-blur-sm rounded-l-lg">
                <TrackLabel
                  label="Original Audio"
                  icon="[S]"
                  muted={trackState.originalMuted}
                  volume={trackState.originalVolume}
                  onMuteToggle={() => updateTrackState({ originalMuted: !trackState.originalMuted })}
                  onVolumeChange={(v) => updateTrackState({ originalVolume: v })}
                />
              </div>
              <div className="relative px-2 py-1" style={{ width: `${trackContentWidth}px` }}>
                <Waveform data={waveformData} totalDuration={totalDuration} currentTime={currentTime} />
              </div>
            </div>

            {/* Speech Track */}
            <div className="flex items-stretch h-10 rounded-lg bg-dark-400/30">
              <div className="sticky left-0 z-10 bg-dark-400/80 backdrop-blur-sm">
                <TrackLabel
                  label="Speech"
                  icon="[M]"
                  muted={trackState.speechMuted}
                  volume={trackState.speechVolume}
                  onMuteToggle={() => updateTrackState({ speechMuted: !trackState.speechMuted })}
                  onVolumeChange={(v) => updateTrackState({ speechVolume: v })}
                />
              </div>
              <div
                ref={speechTrackRef}
                className="relative px-2 py-1 cursor-crosshair"
                style={{ width: `${trackContentWidth}px` }}
                onClick={handleSpeechTrackClick}
              >
                {speechChunks.length === 0 && !addingChunk ? (
                  <div className="w-full h-full flex items-center text-[9px] text-white/20 pointer-events-none pl-2">
                    {isActive ? "Click to add speech" : "No voiceover"}
                  </div>
                ) : (
                  speechChunks.map((chunk) => {
                    const leftPct = totalDuration > 0 ? (chunk.start_time / totalDuration) * 100 : 0;
                    const duration = (chunk.end_time || chunk.start_time + 3) - chunk.start_time;
                    const widthPct = totalDuration > 0 ? (duration / totalDuration) * 100 : 5;

                    let adjustedLeft = leftPct;
                    if (dragDelta && dragDelta.chunkId === chunk.chunk_id) {
                      adjustedLeft += dragDelta.deltaPct;
                    }

                    return (
                      <div
                        key={chunk.chunk_id}
                        data-speech-chunk
                        className={`absolute top-1 bottom-1 rounded bg-blue-500/20 border border-blue-400/30 px-1 flex items-center overflow-hidden transition-colors cursor-grab active:cursor-grabbing ${
                          dragDelta?.chunkId === chunk.chunk_id ? "border-blue-400/60 shadow-lg" : "hover:border-blue-400/60"
                        }`}
                        style={{ left: `${adjustedLeft}%`, width: `${widthPct}%`, minWidth: "24px" }}
                        title={`${chunk.text} (drag to move)`}
                        onMouseDown={(e) => handleChunkDragStart(chunk.chunk_id, e)}
                        onClick={(e) => handleChunkClick(chunk, e)}
                      >
                        <span className="text-[8px] text-blue-300/80 truncate leading-tight pointer-events-none">
                          {chunk.text}
                        </span>
                      </div>
                    );
                  })
                )}

                {addingChunk && (
                  <div
                    className="absolute top-0 bottom-0 w-0.5 bg-blue-400/60"
                    style={{ left: `${(addingChunk.time / totalDuration) * 100}%` }}
                  />
                )}
              </div>
            </div>

            {/* Music Track */}
            <div className="flex items-stretch h-10 rounded-lg bg-dark-400/30">
              <div className="sticky left-0 z-10 bg-dark-400/80 backdrop-blur-sm rounded-l-lg">
                <TrackLabel
                  label="Music"
                  icon="[N]"
                  muted={trackState.musicMuted}
                  volume={trackState.musicVolume}
                  onMuteToggle={() => updateTrackState({ musicMuted: !trackState.musicMuted })}
                  onVolumeChange={(v) => updateTrackState({ musicVolume: v })}
                />
              </div>
              <div
                ref={musicTrackRef}
                className={`relative px-2 py-1 ${keyframesEditable ? "cursor-crosshair" : ""}`}
                style={{ width: `${trackContentWidth}px` }}
                onClick={handleMusicTrackClick}
              >
                {!music ? (
                  <div className="w-full h-full flex items-center text-[9px] text-white/20 pointer-events-none pl-2">
                    No music
                  </div>
                ) : (
                  <>
                    <div
                      data-music-bar
                      className="absolute top-1 bottom-1 left-0 rounded bg-purple-500/10 border border-purple-400/20 overflow-hidden"
                      style={{
                        width: music.placement
                          ? `${(music.placement.end_time / totalDuration) * 100}%`
                          : "100%",
                        minWidth: "60px",
                      }}
                    />
                    <button
                      ref={musicTriggerRef}
                      data-music-bar
                      onClick={(e) => { e.stopPropagation(); handleMusicClick(); }}
                      className="absolute top-1 left-1 z-[5] rounded bg-purple-500/30 border border-purple-400/40 px-1.5 py-0.5 flex items-center gap-1 max-w-[60%] overflow-hidden hover:border-purple-400/70 transition-all cursor-pointer"
                      title={`${music.title} by ${music.artist} -- click to change track`}
                    >
                      <span className="text-[8px] text-purple-200/90 truncate">
                        {music.title} -- {music.artist}
                      </span>
                    </button>
                    <MusicKeyframes
                      keyframes={musicKeyframes}
                      totalDuration={totalDuration}
                      editable={keyframesEditable}
                      onSelect={handleKeyframeSelect}
                    />
                  </>
                )}
              </div>
            </div>

            {/* Time ruler */}
            <div className="flex items-stretch h-4">
              <div className="sticky left-0 z-10 w-[120px] flex-shrink-0 bg-dark-400/80" />
              <div className="relative" style={{ width: `${trackContentWidth}px` }}>
                {pxPerSec > 0 && Array.from({ length: Math.floor(totalDuration / 5) + 1 }, (_, i) => i * 5).map((t) => (
                  <div key={t} className="absolute flex flex-col items-center" style={{ left: `${8 + t * pxPerSec}px` }}>
                    <div className="w-px h-1.5 bg-white/20" />
                    <span className="text-[8px] text-white/30 mt-0.5">{t}s</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Add chunk inline form */}
      {addingChunk && (
        <div className="flex items-center gap-2 ml-[120px] pl-2 py-1">
          <div className="text-[9px] text-white/30">{addingChunk.time.toFixed(1)}s:</div>
          <input
            type="text"
            value={newChunkText}
            onChange={(e) => setNewChunkText(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") handleAddChunkConfirm(); if (e.key === "Escape") setAddingChunk(null); }}
            placeholder="Type speech text..."
            autoFocus
            className="flex-1 max-w-[240px] rounded bg-dark-300 border border-blue-400/30 px-2 py-1 text-[10px] text-white placeholder-white/30 focus:outline-none focus:border-blue-400/60"
          />
          <button
            onClick={handleAddChunkConfirm}
            disabled={!newChunkText.trim() || isAddingRendering}
            className="px-2 py-1 rounded bg-blue-500/20 text-blue-400 text-[9px] border border-blue-500/30 hover:bg-blue-500/30 transition-all disabled:opacity-40"
          >
            {isAddingRendering ? "..." : "Add"}
          </button>
          <button
            onClick={() => setAddingChunk(null)}
            className="px-2 py-1 rounded text-white/30 text-[9px] hover:text-white/60 transition-all"
          >
            Cancel
          </button>
        </div>
      )}

      {/* Auto-ducking toggle (music track) */}
      {music && onAutoDuckChange && (
        <div className="flex items-center gap-2 ml-[120px] pl-2 pt-1">
          <span className="text-[9px] text-white/40">Auto-duck music under speech</span>
          <button
            onClick={() => onAutoDuckChange(!autoDuck)}
            className={`w-8 h-4 rounded-full transition-all relative ${
              autoDuck ? "bg-gold-400/40 border border-gold-400/50" : "bg-dark-300 border border-white/10"
            }`}
            role="switch"
            aria-checked={autoDuck}
            aria-label="Auto-duck music under speech"
          >
            <div
              className={`w-3 h-3 rounded-full absolute top-[1px] transition-all ${
                autoDuck ? "left-[17px] bg-gold-400" : "left-[2px] bg-white/30"
              }`}
            />
          </button>
          <span className="text-[9px] text-white/30">
            {autoDuck ? "Automatic" : "Manual (click dots to edit, click track to add)"}
          </span>
        </div>
      )}

      {/* Music Panel */}
      {musicPanelOpen && (
        <MusicPanel
          triggerRect={triggerRect}
          currentMusic={music}
          onFeedbackSubmit={handleFeedbackSubmit}
          onSearchQuery={handleSearchQuery}
          onTrackSelect={handleTrackSelect}
          onClose={() => setMusicPanelOpen(false)}
          isRefining={isRefining}
        />
      )}

      {/* Speech Edit Panel */}
      {editingChunk && projectId && (
        <SpeechEditPanel
          chunk={editingChunk}
          position={editPanelPos}
          voiceName={voiceName}
          projectId={projectId}
          onUpdate={handleChunkUpdate}
          onDelete={handleChunkDelete}
          onClose={() => setEditingChunk(null)}
        />
      )}

      {/* Music Keyframe Editor */}
      {editingKfIndex !== null && musicKeyframes[editingKfIndex] && (
        <KeyframeEditor
          keyframe={musicKeyframes[editingKfIndex]}
          position={kfEditorPos}
          onChange={handleKeyframeVolumeChange}
          onDelete={handleKeyframeDelete}
          onClose={() => setEditingKfIndex(null)}
        />
      )}
    </div>
  );
}
