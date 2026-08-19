import { useCallback, useEffect, useRef, useState } from "react";
import type { Proposal, TimelineSegment } from "../types";
import Loader from "./Loader";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

interface VideoPlayerProps {
  proposal: Proposal | null;
  clipUrls: Record<string, string>;
  onTimeUpdate?: (time: number) => void;
  /** Direct DOM ref for external playhead element */
  playheadRef?: React.RefObject<HTMLDivElement | null>;
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}:${remainder.toString().padStart(2, "0")}`;
}

/**
 * VideoPlayer that pre-loads ALL clip files into separate video elements.
 * During playback, we just show/hide the correct element and seek -- no src changes.
 * This eliminates any loading flash between segments.
 */
export default function VideoPlayer({ proposal, clipUrls, onTimeUpdate, playheadRef }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSegmentIdx, setCurrentSegmentIdx] = useState(0);
  const [timelineTime, setTimelineTime] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const rafRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const segmentIdxRef = useRef(0);
  // Direct DOM refs for smooth updates without re-renders
  const progressBarRef = useRef<HTMLDivElement>(null);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);

  const timeline = proposal?.timeline || [];
  const totalDuration = proposal?.total_duration || 0;

  // Get media URL for a segment
  const getSegmentUrl = useCallback(
    (segment: TimelineSegment): string => {
      if (clipUrls[segment.clip_id]) return clipUrls[segment.clip_id];
      if (clipUrls[segment.filename]) return clipUrls[segment.filename];

      for (const [key, url] of Object.entries(clipUrls)) {
        if (key.includes(segment.clip_id) || segment.clip_id.includes(key)) return url;
        if (key.includes(segment.filename) || segment.filename.includes(key)) return url;
      }

      const cleanFilename = segment.filename.replace(/^[a-f0-9-]+_/, "");
      for (const [key, url] of Object.entries(clipUrls)) {
        if (key.includes(cleanFilename) || cleanFilename.includes(key)) return url;
      }

      return `${API_URL}/media/${segment.clip_id}_${segment.filename}`;
    },
    [clipUrls]
  );

  // Get unique clip URLs from the timeline
  const uniqueClipUrls = useCallback((): string[] => {
    const urls = new Set<string>();
    for (const seg of timeline) {
      urls.add(getSegmentUrl(seg));
    }
    return Array.from(urls);
  }, [timeline, getSegmentUrl]);

  // Create and load all video elements
  useEffect(() => {
    if (!proposal || timeline.length === 0) {
      setAllLoaded(false);
      return;
    }

    const container = containerRef.current;
    if (!container) return;

    const urls = uniqueClipUrls();
    const existingMap = videosRef.current;
    let loadedCount = 0;
    const totalToLoad = urls.length;

    setAllLoaded(false);

    // Remove old elements not needed
    for (const [url, el] of existingMap.entries()) {
      if (!urls.includes(url)) {
        el.pause();
        el.remove();
        existingMap.delete(url);
      }
    }

    // Create/reuse elements for each URL
    for (const url of urls) {
      let video = existingMap.get(url);
      if (!video) {
        video = document.createElement("video");
        video.playsInline = true;
        video.preload = "auto";
        video.style.position = "absolute";
        video.style.inset = "0";
        video.style.width = "100%";
        video.style.height = "100%";
        video.style.objectFit = "contain";
        video.style.opacity = "0";
        video.src = url;
        container.appendChild(video);
        existingMap.set(url, video);

        video.addEventListener("loadeddata", () => {
          loadedCount++;
          if (loadedCount >= totalToLoad) {
            setAllLoaded(true);
          }
        }, { once: true });

        video.load();
      } else {
        // Already loaded
        loadedCount++;
        if (loadedCount >= totalToLoad) {
          setAllLoaded(true);
        }
      }
    }

    // If all were already cached
    if (loadedCount >= totalToLoad) {
      setAllLoaded(true);
    }
  }, [proposal, timeline, uniqueClipUrls]);

  // Show only the video for the current segment
  const showSegment = useCallback(
    (idx: number) => {
      const segment = timeline[idx];
      if (!segment) return;

      const url = getSegmentUrl(segment);
      const map = videosRef.current;

      // Hide all, show current
      for (const [vUrl, el] of map.entries()) {
        if (vUrl === url) {
          el.style.opacity = "1";
          el.style.zIndex = "10";
        } else {
          el.style.opacity = "0";
          el.style.zIndex = "0";
          el.pause();
        }
      }
    },
    [timeline, getSegmentUrl]
  );

  // Stable animation loop via ref (avoids stale closure issues with useCallback)
  const tickFnRef = useRef<() => void>(() => {});
  const lastStateUpdateRef = useRef(0);

  // Update the tick function on every render (always has fresh closures)
  tickFnRef.current = () => {
    if (!isPlayingRef.current) return;

    const idx = segmentIdxRef.current;
    const segment = timeline[idx];
    if (!segment) {
      rafRef.current = requestAnimationFrame(() => tickFnRef.current());
      return;
    }

    const url = getSegmentUrl(segment);
    const video = videosRef.current.get(url);
    if (!video) {
      rafRef.current = requestAnimationFrame(() => tickFnRef.current());
      return;
    }

    // Ensure video is playing
    if (video.paused && isPlayingRef.current) {
      video.play().catch(() => {});
    }

    // Calculate timeline position
    const clipProgress = Math.max(0, video.currentTime - segment.start);
    const timelinePos = segment.position_in_timeline + clipProgress;
    const clamped = Math.max(0, Math.min(timelinePos, totalDuration));

    // Direct DOM updates (smooth, no re-render)
    const pct = totalDuration > 0 ? (clamped / totalDuration) * 100 : 0;
    if (progressBarRef.current) {
      progressBarRef.current.style.width = `${pct}%`;
    }
    if (timeDisplayRef.current) {
      const s = Math.floor(clamped);
      const m = Math.floor(s / 60);
      const r = s % 60;
      timeDisplayRef.current.textContent = `${m}:${r.toString().padStart(2, "0")} / ${formatTime(totalDuration)}`;
    }
    if (playheadRef?.current) {
      playheadRef.current.style.left = `${pct}%`;
    }

    // Update React state less frequently (for Timeline playhead)
    const now = performance.now();
    if (now - lastStateUpdateRef.current > 200) {
      lastStateUpdateRef.current = now;
      setTimelineTime(clamped);
      if (onTimeUpdate) onTimeUpdate(clamped);
    }

    // Check if segment ended
    if (video.currentTime >= segment.end - 0.05) {
      const nextIdx = idx + 1;
      if (nextIdx < timeline.length) {
        video.pause();
        segmentIdxRef.current = nextIdx;
        setCurrentSegmentIdx(nextIdx);
        const nextSeg = timeline[nextIdx];
        const nextUrl = getSegmentUrl(nextSeg);
        const nextVideo = videosRef.current.get(nextUrl);
        if (nextVideo) {
          showSegment(nextIdx);
          nextVideo.currentTime = nextSeg.start;
          nextVideo.play().catch(() => {});
        }
      } else {
        video.pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
        // Final state update
        setTimelineTime(totalDuration);
        if (onTimeUpdate) onTimeUpdate(totalDuration);
        return;
      }
    }

    rafRef.current = requestAnimationFrame(() => tickFnRef.current());
  };

  // Start/stop the animation loop
  useEffect(() => {
    if (isPlaying) {
      isPlayingRef.current = true;
      rafRef.current = requestAnimationFrame(() => tickFnRef.current());
    } else {
      isPlayingRef.current = false;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
    return () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [isPlaying]);

  // Play/pause toggle
  const togglePlay = () => {
    if (!proposal || !allLoaded) return;

    if (isPlaying) {
      // Pause current
      const segment = timeline[currentSegmentIdx];
      if (segment) {
        const url = getSegmentUrl(segment);
        const video = videosRef.current.get(url);
        if (video) video.pause();
      }
      setIsPlaying(false);
    } else {
      // Check if at end -- restart
      const lastSeg = timeline[timeline.length - 1];
      if (lastSeg && currentSegmentIdx >= timeline.length - 1) {
        const url = getSegmentUrl(lastSeg);
        const video = videosRef.current.get(url);
        if (video && video.currentTime >= lastSeg.end - 0.1) {
          // Restart from beginning
          setCurrentSegmentIdx(0);
          segmentIdxRef.current = 0;
          const firstSeg = timeline[0];
          const firstUrl = getSegmentUrl(firstSeg);
          const firstVideo = videosRef.current.get(firstUrl);
          if (firstVideo) {
            showSegment(0);
            firstVideo.currentTime = firstSeg.start;
            firstVideo.play().catch(() => {});
          }
          setIsPlaying(true);
          return;
        }
      }

      // Resume current segment
      const segment = timeline[currentSegmentIdx];
      if (segment) {
        const url = getSegmentUrl(segment);
        const video = videosRef.current.get(url);
        if (video) {
          showSegment(currentSegmentIdx);
          video.play().catch(() => {});
        }
      }
      setIsPlaying(true);
    }
  };

  // Scrub
  const handleScrub = (e: React.MouseEvent<HTMLDivElement>) => {
    if (!proposal || totalDuration === 0 || !allLoaded) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const targetTime = pct * totalDuration;

    for (let i = 0; i < timeline.length; i++) {
      const seg = timeline[i];
      const segDuration = seg.end - seg.start;
      const segEnd = seg.position_in_timeline + segDuration;
      if (targetTime <= segEnd || i === timeline.length - 1) {
        const offsetInSeg = targetTime - seg.position_in_timeline;
        const seekTo = seg.start + Math.max(0, Math.min(offsetInSeg, segDuration));

        // Pause current
        const curSeg = timeline[currentSegmentIdx];
        if (curSeg) {
          const curUrl = getSegmentUrl(curSeg);
          const curVideo = videosRef.current.get(curUrl);
          if (curVideo) curVideo.pause();
        }

        setCurrentSegmentIdx(i);
        segmentIdxRef.current = i;
        setTimelineTime(targetTime);
        showSegment(i);

        const url = getSegmentUrl(seg);
        const video = videosRef.current.get(url);
        if (video) {
          video.currentTime = seekTo;
        }
        break;
      }
    }
  };

  // Reset when proposal changes
  useEffect(() => {
    setCurrentSegmentIdx(0);
    segmentIdxRef.current = 0;
    setTimelineTime(0);
    setIsPlaying(false);
    isPlayingRef.current = false;

    // Pause all
    for (const [, el] of videosRef.current.entries()) {
      el.pause();
    }

    if (proposal && timeline.length > 0 && allLoaded) {
      showSegment(0);
      const firstSeg = timeline[0];
      const url = getSegmentUrl(firstSeg);
      const video = videosRef.current.get(url);
      if (video) {
        video.currentTime = firstSeg.start;
      }
    }
  }, [proposal, allLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const progressPct = totalDuration > 0 ? (timelineTime / totalDuration) * 100 : 0;

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="relative rounded-xl overflow-hidden bg-black flex-1 cursor-pointer" onClick={togglePlay}>
        {/* Container for dynamically created video elements */}
        <div ref={containerRef} className="absolute inset-0" />

        {/* Loading overlay -- only shown during initial load */}
        {!allLoaded && proposal && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-20">
            <Loader size="md" />
          </div>
        )}
        {!proposal && (
          <div className="absolute inset-0 flex items-center justify-center z-20">
            <p className="text-white/30 text-sm">Select a proposal to preview</p>
          </div>
        )}
        {/* Play/pause overlay icon on video */}
        {proposal && allLoaded && !isPlaying && (
          <div className="absolute inset-0 flex items-center justify-center z-15 pointer-events-none">
            <div className="w-14 h-14 rounded-full glass-light flex items-center justify-center opacity-70">
              <svg className="w-6 h-6 text-white ml-1" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </div>
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="flex items-center gap-3">
        <button
          onClick={togglePlay}
          disabled={!proposal || !allLoaded}
          className="w-9 h-9 rounded-lg glass-light flex items-center justify-center text-green-400 hover:text-green-300 disabled:text-white/20 disabled:cursor-not-allowed"
          aria-label={isPlaying ? "Pause" : "Play"}
        >
          {isPlaying ? (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <rect x="6" y="4" width="4" height="16" rx="1" />
              <rect x="14" y="4" width="4" height="16" rx="1" />
            </svg>
          ) : (
            <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        <div
          onClick={handleScrub}
          className="flex-1 h-2 rounded-full bg-dark-300 cursor-pointer relative overflow-hidden"
        >
          <div
            ref={progressBarRef}
            className="absolute inset-y-0 left-0 bg-green-500 rounded-full"
            style={{ width: `${progressPct}%` }}
          />
        </div>

        <span ref={timeDisplayRef} className="text-xs text-white/50 font-mono min-w-[80px] text-right">
          {formatTime(timelineTime)} / {formatTime(totalDuration)}
        </span>
      </div>
    </div>
  );
}
