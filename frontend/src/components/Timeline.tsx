import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { Proposal, Transition, TimelineSegment, Filter } from "../types";

interface TimelineProps {
  proposal: Proposal;
  currentTime: number;
  totalDuration: number;
  isActive?: boolean;
  onClick?: () => void;
  clipUrls?: Record<string, string>;
  playheadRef?: React.RefObject<HTMLDivElement | null>;
  onTransitionChange?: (segmentIndex: number, transition: Transition) => void;
  onFilterChange?: (segmentIndex: number, filter: Filter) => void;
  onBrightnessChange?: (segmentIndex: number, brightness: number) => void;
}

const TRANSITION_TYPES: { type: Transition["type"]; label: string; abbr: string }[] = [
  { type: "cut", label: "Cut", abbr: "C" },
  { type: "crossfade", label: "Crossfade", abbr: "X" },
  { type: "fade_to_black", label: "Fade to Black", abbr: "FB" },
  { type: "fade_to_white", label: "Fade to White", abbr: "FW" },
  { type: "wipe_left", label: "Wipe Left", abbr: "WL" },
  { type: "wipe_right", label: "Wipe Right", abbr: "WR" },
  { type: "zoom_in", label: "Zoom In", abbr: "Z" },
  { type: "blur", label: "Blur", abbr: "B" },
];

const DEFAULT_DURATIONS: Record<string, number> = {
  cut: 0, crossfade: 0.5, fade_to_black: 0.8, fade_to_white: 0.8,
  wipe_left: 0.5, wipe_right: 0.5, zoom_in: 0.5, blur: 0.7,
};

const FILTER_OPTIONS: { type: Filter["type"]; label: string; color: string }[] = [
  { type: "none", label: "None", color: "bg-white/10" },
  { type: "grayscale", label: "B&W", color: "bg-gray-400" },
  { type: "sepia", label: "Sepia", color: "bg-amber-600" },
  { type: "high_contrast", label: "Contrast", color: "bg-white" },
  { type: "warm", label: "Warm", color: "bg-orange-400" },
  { type: "cool", label: "Cool", color: "bg-blue-400" },
  { type: "vintage", label: "Vintage", color: "bg-yellow-700" },
  { type: "dramatic", label: "Dramatic", color: "bg-purple-600" },
];

function getTimeTicks(duration: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += 5) ticks.push(t);
  return ticks;
}

function getTransition(segment: TimelineSegment): Transition {
  if (typeof segment.transition === "object" && segment.transition !== null) {
    return segment.transition as Transition;
  }
  const type = (typeof segment.transition === "string" ? segment.transition : "cut") as Transition["type"];
  return { type, duration: DEFAULT_DURATIONS[type] || 0 };
}

function getTransitionAbbr(type: string): string {
  return TRANSITION_TYPES.find((t) => t.type === type)?.abbr || "C";
}

/** Portal dropdown at body level */
function PortalDropdown({
  anchorRef,
  open,
  onClose,
  children,
  position = "above",
}: {
  anchorRef: React.RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
  position?: "above" | "below";
}) {
  const [coords, setCoords] = useState({ top: 0, left: 0 });

  useEffect(() => {
    if (open && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      if (position === "above") {
        setCoords({ top: rect.top - 4, left: rect.left + rect.width / 2 });
      } else {
        setCoords({ top: rect.bottom + 4, left: rect.right });
      }
    }
  }, [open, anchorRef, position]);

  if (!open) return null;

  return createPortal(
    <>
      <div className="fixed inset-0 z-[200]" onClick={(e) => { e.stopPropagation(); onClose(); }} />
      <div
        className="fixed z-[201] glass-strong rounded-lg shadow-xl border border-white/10"
        style={{
          top: position === "above" ? undefined : `${coords.top}px`,
          bottom: position === "above" ? `${window.innerHeight - coords.top}px` : undefined,
          left: position === "above" ? `${coords.left}px` : undefined,
          right: position === "below" ? `${window.innerWidth - coords.left}px` : undefined,
          transform: position === "above" ? "translateX(-50%)" : undefined,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {children}
      </div>
    </>,
    document.body
  );
}

/** Transition button -- sits between clips, overlapping the join */
function TransitionButton({
  transition,
  segmentIndex,
  onSelect,
  isActive,
}: {
  transition: Transition;
  segmentIndex: number;
  onSelect?: (segmentIndex: number, transition: Transition) => void;
  isActive: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);

  if (!isActive || !onSelect) {
    if (transition.type === "cut") return null;
    return (
      <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20 w-5 h-5 rounded-full bg-dark-300 border border-white/10 flex items-center justify-center">
        <span className="text-[7px] text-gold-400 font-bold">{getTransitionAbbr(transition.type)}</span>
      </div>
    );
  }

  return (
    <div className="absolute top-1/2 -translate-y-1/2 -translate-x-1/2 z-20">
      <button
        ref={btnRef}
        onClick={(e) => { e.stopPropagation(); setOpen(!open); }}
        className={`w-6 h-6 rounded-full flex items-center justify-center transition-all ${
          transition.type !== "cut"
            ? "bg-dark-200 border-2 border-green-400/50"
            : "bg-dark-300 border border-white/15 hover:border-white/30"
        }`}
        title={`Transition: ${transition.type} (${transition.duration}s)`}
      >
        <span className={`text-[8px] font-bold ${transition.type !== "cut" ? "text-gold-400" : "text-white/40"}`}>
          {getTransitionAbbr(transition.type)}
        </span>
      </button>
      <PortalDropdown anchorRef={btnRef} open={open} onClose={() => setOpen(false)} position="above">
        <div className="p-1.5 min-w-[120px]">
          {TRANSITION_TYPES.map((t) => (
            <button
              key={t.type}
              onClick={(e) => {
                e.stopPropagation();
                onSelect(segmentIndex, { type: t.type, duration: DEFAULT_DURATIONS[t.type] });
                setOpen(false);
              }}
              className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 transition-colors ${
                transition.type === t.type ? "bg-green-500/20 text-green-400" : "text-white/60 hover:bg-white/5 hover:text-white/80"
              }`}
            >
              <span className="w-5 text-[9px] font-bold text-gold-400">{t.abbr}</span>
              <span>{t.label}</span>
            </button>
          ))}
        </div>
      </PortalDropdown>
    </div>
  );
}

/** Filmstrip: renders tiled frame thumbnails for a segment */
function Filmstrip({ clipUrl, start, end }: { clipUrl: string | undefined; start: number; end: number }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [frames, setFrames] = useState<string[]>([]);

  useEffect(() => {
    if (!clipUrl || !containerRef.current) return;

    const containerWidth = containerRef.current.offsetWidth;
    const frameWidth = 40;
    const numFrames = Math.max(1, Math.min(8, Math.floor(containerWidth / frameWidth)));
    const duration = end - start;

    let active = true;

    async function capture() {
      const video = document.createElement("video");
      video.crossOrigin = "anonymous";
      video.src = clipUrl!;
      video.muted = true;
      video.playsInline = true;
      video.preload = "auto";

      // Wait for video to be loadable
      const loaded = await new Promise<boolean>((resolve) => {
        video.addEventListener("loadeddata", () => resolve(true), { once: true });
        video.addEventListener("error", () => resolve(false), { once: true });
        setTimeout(() => resolve(false), 6000);
      });

      if (!loaded || !active) { video.src = ""; return; }

      const captured: string[] = [];
      for (let i = 0; i < numFrames; i++) {
        if (!active) break;
        const t = start + (duration * (i + 0.5)) / numFrames;
        video.currentTime = Math.min(t, video.duration - 0.1);

        await new Promise<void>((resolve) => {
          video.addEventListener("seeked", () => resolve(), { once: true });
          setTimeout(() => resolve(), 2000);
        });

        try {
          const canvas = document.createElement("canvas");
          canvas.width = 80;
          canvas.height = 48;
          const ctx = canvas.getContext("2d");
          if (ctx) {
            ctx.drawImage(video, 0, 0, 80, 48);
            captured.push(canvas.toDataURL("image/jpeg", 0.5));
          }
        } catch {
          // CORS or other issue -- skip this frame
        }
      }

      video.src = "";
      if (active && captured.length > 0) setFrames(captured);
    }

    capture();
    return () => { active = false; };
  }, [clipUrl, start, end]);

  return (
    <div ref={containerRef} className="absolute inset-0 flex overflow-hidden">
      {frames.length > 0
        ? frames.map((f, i) => (
            <img key={i} src={f} className="h-full flex-1 object-cover" alt="" draggable={false} />
          ))
        : <div className="w-full h-full bg-dark-200" />
      }
    </div>
  );
}

/** Effects bar: pill-shaped badges for filter and brightness below each segment */
function EffectsBar({
  segment,
  segmentIndex,
  isActive,
  onFilterChange,
  onBrightnessChange,
}: {
  segment: TimelineSegment;
  segmentIndex: number;
  isActive: boolean;
  onFilterChange?: (segmentIndex: number, filter: Filter) => void;
  onBrightnessChange?: (segmentIndex: number, brightness: number) => void;
}) {
  const [filterOpen, setFilterOpen] = useState(false);
  const [brightnessOpen, setBrightnessOpen] = useState(false);
  const [intensity, setIntensity] = useState(segment.filter?.intensity ?? 0.8);
  const [brightnessVal, setBrightnessVal] = useState(segment.brightness_adjustment ?? 1.0);
  const filterBtnRef = useRef<HTMLButtonElement>(null);
  const brightnessBtnRef = useRef<HTMLButtonElement>(null);

  const hasFilter = segment.filter && segment.filter.type !== "none";
  const hasBrightness = segment.brightness_adjustment && segment.brightness_adjustment !== 1.0;

  if (!hasFilter && !hasBrightness && !isActive) return null;

  const filterLabel = hasFilter
    ? FILTER_OPTIONS.find((f) => f.type === segment.filter!.type)?.label || segment.filter!.type
    : null;

  const brightnessLabel = hasBrightness
    ? `Brightness ${segment.brightness_adjustment! > 1 ? "+" : ""}${Math.round((segment.brightness_adjustment! - 1) * 100)}%`
    : null;

  return (
    <div className="flex items-center gap-1 h-6 overflow-hidden">
      {/* Filter pill */}
      {(hasFilter || isActive) && (
        <>
          <button
            ref={filterBtnRef}
            onClick={(e) => { e.stopPropagation(); if (isActive) setFilterOpen(!filterOpen); }}
            className={`h-5 px-2 rounded-full text-[10px] font-medium truncate max-w-full flex items-center gap-1 transition-all ${
              hasFilter
                ? "bg-gold-500/20 border border-gold-400/30 text-gold-400"
                : "bg-dark-300/60 border border-white/10 text-white/30 hover:text-white/50"
            }`}
            title={hasFilter ? `Filter: ${filterLabel}` : "Add filter"}
          >
            {hasFilter ? filterLabel : isActive ? "+ Filter" : ""}
          </button>
          <PortalDropdown anchorRef={filterBtnRef} open={filterOpen} onClose={() => setFilterOpen(false)} position="below">
            <div className="p-2 min-w-[140px]">
              <div className="space-y-0.5 mb-2">
                {FILTER_OPTIONS.map((f) => (
                  <button
                    key={f.type}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (onFilterChange) onFilterChange(segmentIndex, { type: f.type, intensity: f.type === "none" ? 0 : intensity });
                      if (f.type === "none") setFilterOpen(false);
                    }}
                    className={`w-full text-left px-2 py-1 rounded text-xs flex items-center gap-2 transition-colors ${
                      segment.filter?.type === f.type ? "bg-green-500/20 text-green-400" : "text-white/60 hover:bg-white/5"
                    }`}
                  >
                    <div className={`w-2.5 h-2.5 rounded-full ${f.color}`} />
                    <span>{f.label}</span>
                  </button>
                ))}
              </div>
              {segment.filter?.type && segment.filter.type !== "none" && (
                <div className="pt-1 border-t border-white/5">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-white/40">Intensity</span>
                    <span className="text-[10px] text-white/50">{Math.round(intensity * 100)}%</span>
                  </div>
                  <input
                    type="range" min={0} max={100}
                    value={Math.round(intensity * 100)}
                    onChange={(e) => {
                      e.stopPropagation();
                      const val = Number(e.target.value) / 100;
                      setIntensity(val);
                      if (onFilterChange && segment.filter) onFilterChange(segmentIndex, { type: segment.filter.type, intensity: val });
                    }}
                    className="w-full h-1.5 accent-green-400"
                  />
                </div>
              )}
            </div>
          </PortalDropdown>
        </>
      )}

      {/* Brightness pill -- editable */}
      {(hasBrightness || isActive) && (
        <>
          <button
            ref={brightnessBtnRef}
            onClick={(e) => { e.stopPropagation(); if (isActive) setBrightnessOpen(!brightnessOpen); }}
            className={`h-5 px-2 rounded-full text-[10px] font-medium truncate max-w-full flex items-center gap-1 transition-all ${
              hasBrightness
                ? "bg-blue-500/15 border border-blue-400/25 text-blue-300"
                : "bg-dark-300/60 border border-white/10 text-white/30 hover:text-white/50"
            }`}
            title={hasBrightness ? brightnessLabel || "" : "Adjust brightness"}
          >
            {hasBrightness ? brightnessLabel : isActive ? "+ Brightness" : ""}
          </button>
          <PortalDropdown anchorRef={brightnessBtnRef} open={brightnessOpen} onClose={() => setBrightnessOpen(false)} position="below">
            <div className="p-3 min-w-[160px]">
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs text-white/50">Brightness</span>
                <span className="text-xs text-white/70 font-medium">
                  {brightnessVal > 1 ? "+" : ""}{Math.round((brightnessVal - 1) * 100)}%
                </span>
              </div>
              <input
                type="range" min={80} max={120}
                value={Math.round(brightnessVal * 100)}
                onChange={(e) => {
                  e.stopPropagation();
                  const val = Number(e.target.value) / 100;
                  setBrightnessVal(val);
                  if (onBrightnessChange) onBrightnessChange(segmentIndex, val);
                }}
                className="w-full h-1.5 accent-blue-400"
              />
              <div className="flex justify-between mt-1">
                <span className="text-[9px] text-white/30">-20%</span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setBrightnessVal(1.0);
                    if (onBrightnessChange) onBrightnessChange(segmentIndex, 1.0);
                  }}
                  className="text-[9px] text-white/40 hover:text-white/60"
                >
                  Reset
                </button>
                <span className="text-[9px] text-white/30">+20%</span>
              </div>
            </div>
          </PortalDropdown>
        </>
      )}
    </div>
  );
}

export default function Timeline({
  proposal,
  currentTime,
  totalDuration,
  isActive = false,
  onClick,
  clipUrls = {},
  playheadRef,
  onTransitionChange,
  onFilterChange,
  onBrightnessChange,
}: TimelineProps) {
  const timeline = proposal.timeline;
  const playheadPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
  const ticks = getTimeTicks(totalDuration);

  const getClipUrl = (segment: { clip_id: string; filename: string }): string | undefined => {
    if (clipUrls[segment.clip_id]) return clipUrls[segment.clip_id];
    if (clipUrls[segment.filename]) return clipUrls[segment.filename];
    for (const [key, url] of Object.entries(clipUrls)) {
      if (key.includes(segment.clip_id) || segment.clip_id.includes(key)) return url;
      if (key.includes(segment.filename) || segment.filename.includes(key)) return url;
    }
    const clean = segment.filename.replace(/^[a-f0-9-]+_/, "");
    for (const [key, url] of Object.entries(clipUrls)) {
      if (key.includes(clean) || clean.includes(key)) return url;
    }
    return undefined;
  };

  // Calculate left position for each segment (for transition button placement)
  const segmentPositions: number[] = [];
  let accumulatedPct = 0;
  for (const seg of timeline) {
    segmentPositions.push(accumulatedPct);
    const segDuration = seg.end - seg.start;
    accumulatedPct += totalDuration > 0 ? (segDuration / totalDuration) * 100 : 0;
  }

  return (
    <div
      onClick={onClick}
      className={`rounded-xl p-3 cursor-pointer transition-all ${
        isActive ? "glass border border-green-500/40" : "glass-light border border-transparent hover:border-white/10"
      }`}
      role="button"
      tabIndex={0}
      aria-label={`Proposal: ${proposal.label}`}
    >
      {/* Label */}
      <div className="flex items-center justify-between mb-2">
        <h4 className={`text-sm font-medium ${isActive ? "text-green-400" : "text-white/80"}`}>
          {proposal.label}
        </h4>
        <span className="text-xs text-white/40">{proposal.total_duration.toFixed(1)}s</span>
      </div>

      {/* Filmstrip track -- segments joined, transitions floating on join */}
      <div className="relative">
        <div className="flex h-16 rounded-lg overflow-hidden bg-dark-400">
          {timeline.map((segment, i) => {
            const segDuration = segment.end - segment.start;
            const widthPct = totalDuration > 0 ? (segDuration / totalDuration) * 100 : 0;
            const url = getClipUrl(segment);

            return (
              <div
                key={`${segment.clip_id}-${i}`}
                data-segment-index={i}
                className="relative h-full overflow-hidden border border-gold-700"
                style={{ width: `${widthPct}%`, minWidth: "20px" }}
              >
                <Filmstrip clipUrl={url} start={segment.start} end={segment.end} />
                <div className="absolute inset-0 bg-black/15" />
              </div>
            );
          })}
        </div>

        {/* Transition buttons floating on segment joins */}
        {timeline.map((segment, i) => {
          if (i === 0) return null;
          const transition = getTransition(segment);
          const leftPct = segmentPositions[i];

          return (
            <div key={`trans-${i}`} className="absolute top-0 h-16" style={{ left: `${leftPct}%` }}>
              <TransitionButton
                transition={transition}
                segmentIndex={i}
                onSelect={onTransitionChange}
                isActive={isActive}
              />
            </div>
          );
        })}

        {/* Playhead */}
        {isActive && (
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 w-0.5 bg-green-400 pointer-events-none z-10"
            style={{ left: `${playheadPct}%` }}
          >
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-green-400 rounded-full" />
          </div>
        )}
      </div>

      {/* Effects bar (filters + brightness pills) */}
      <div className="flex mt-1.5 h-6">
        {timeline.map((segment, i) => {
          const segDuration = segment.end - segment.start;
          const widthPct = totalDuration > 0 ? (segDuration / totalDuration) * 100 : 0;

          return (
            <div key={`fx-${i}`} className="overflow-hidden" style={{ width: `${widthPct}%`, minWidth: "20px" }}>
              <EffectsBar
                segment={segment}
                segmentIndex={i}
                isActive={isActive}
                onFilterChange={onFilterChange}
                onBrightnessChange={onBrightnessChange}
              />
            </div>
          );
        })}
      </div>

      {/* Time ruler */}
      <div className="relative h-4 mt-1">
        {ticks.map((t) => {
          const pct = totalDuration > 0 ? (t / totalDuration) * 100 : 0;
          return (
            <div key={t} className="absolute flex flex-col items-center" style={{ left: `${pct}%` }}>
              <div className="w-px h-1.5 bg-white/20" />
              <span className="text-[8px] text-white/30 mt-0.5">{t}s</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
