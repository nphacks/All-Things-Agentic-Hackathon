import type { Proposal } from "../types";

interface TimelineProps {
  proposal: Proposal;
  currentTime: number;
  totalDuration: number;
  isActive?: boolean;
  onClick?: () => void;
  thumbnails?: Record<string, string>;
  clipUrls?: Record<string, string>;
  playheadRef?: React.RefObject<HTMLDivElement | null>;
}

/** Generate time ruler ticks every 5 seconds */
function getTimeTicks(duration: number): number[] {
  const ticks: number[] = [];
  for (let t = 0; t <= duration; t += 5) {
    ticks.push(t);
  }
  return ticks;
}

/** Truncate filename for display */
function shortName(filename: string): string {
  // Remove UUID prefix if present (e.g., "abc123_beach-waves.mp4" -> "beach-waves.mp4")
  const parts = filename.split("_");
  const name = parts.length > 1 ? parts.slice(1).join("_") : filename;
  // Remove extension
  return name.replace(/\.\w+$/, "");
}

export default function Timeline({
  proposal,
  currentTime,
  totalDuration,
  isActive = false,
  onClick,
  thumbnails = {},
  clipUrls = {},
  playheadRef,
}: TimelineProps) {
  const timeline = proposal.timeline;
  const playheadPct = totalDuration > 0 ? (currentTime / totalDuration) * 100 : 0;
  const ticks = getTimeTicks(totalDuration);

  // Find thumbnail for a segment
  const getThumb = (segment: { clip_id: string; filename: string }): string | undefined => {
    const url = clipUrls[segment.clip_id] || clipUrls[segment.filename];
    if (url && thumbnails[url]) return thumbnails[url];
    for (const [key, thumbUrl] of Object.entries(thumbnails)) {
      if (key.includes(segment.clip_id) || segment.clip_id.includes(key.split("/").pop() || "")) {
        return thumbUrl;
      }
    }
    return undefined;
  };

  return (
    <div
      onClick={onClick}
      className={`
        rounded-xl p-3 cursor-pointer transition-all
        ${isActive
          ? "glass border border-green-500/40"
          : "glass-light border border-transparent hover:border-white/10"
        }
      `}
      role="button"
      tabIndex={0}
      aria-label={`Proposal: ${proposal.label}`}
    >
      {/* Label */}
      <div className="flex items-center justify-between mb-2">
        <h4 className={`text-sm font-medium ${isActive ? "text-green-400" : "text-white/80"}`}>
          {proposal.label}
        </h4>
        <span className="text-xs text-white/40">
          {proposal.total_duration.toFixed(1)}s
        </span>
      </div>

      {/* Track */}
      <div className="relative">
        {/* Segments */}
        <div className="flex gap-0.5 h-12 rounded-lg overflow-hidden bg-dark-400">
          {timeline.map((segment, i) => {
            const segDuration = segment.end - segment.start;
            const widthPct = totalDuration > 0 ? (segDuration / totalDuration) * 100 : 0;
            const thumb = getThumb(segment);

            return (
              <div
                key={`${segment.clip_id}-${i}`}
                data-segment-index={i}
                data-clip-id={segment.clip_id}
                className="relative flex flex-col justify-end overflow-hidden border-l-2 border-green-500/60 transition-colors"
                style={{
                  width: `${widthPct}%`,
                  minWidth: "24px",
                  backgroundImage: thumb ? `url(${thumb})` : undefined,
                  backgroundSize: "cover",
                  backgroundPosition: "center",
                  backgroundColor: thumb ? undefined : "var(--color-dark-200)",
                }}
                title={`${segment.filename} (${segment.start}s - ${segment.end}s)`}
              >
                {/* Dark overlay for text readability */}
                <div className="absolute inset-0 bg-black/40" />
                {/* Text at bottom */}
                <div className="relative px-1 pb-0.5">
                  <span className="text-[9px] text-white/80 truncate block leading-tight">
                    {shortName(segment.filename)}
                  </span>
                  <span className="text-[8px] text-white/50">
                    {segDuration.toFixed(1)}s
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Playhead */}
        {isActive && (
          <div
            ref={playheadRef}
            className="absolute top-0 bottom-0 w-0.5 bg-green-400 pointer-events-none z-10"
            style={{ left: `${playheadPct}%` }}
          >
            {/* Playhead top marker */}
            <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-green-400 rounded-full" />
          </div>
        )}
      </div>

      {/* Time ruler */}
      <div className="relative h-4 mt-1">
        {ticks.map((t) => {
          const pct = totalDuration > 0 ? (t / totalDuration) * 100 : 0;
          return (
            <div
              key={t}
              className="absolute flex flex-col items-center"
              style={{ left: `${pct}%` }}
            >
              <div className="w-px h-1.5 bg-white/20" />
              <span className="text-[8px] text-white/30 mt-0.5">{t}s</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
