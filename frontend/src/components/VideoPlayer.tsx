import { useCallback, useEffect, useRef, useState } from "react";
import type { Proposal, TimelineSegment, Transition } from "../types";
import Loader from "./Loader";

const API_URL = import.meta.env.VITE_API_URL || "http://localhost:8080";

interface VideoPlayerProps {
  proposal: Proposal | null;
  clipUrls: Record<string, string>;
  onTimeUpdate?: (time: number) => void;
  onPlayStateChange?: (isPlaying: boolean) => void;
  videoVolume?: number;
  playheadRef?: React.RefObject<HTMLDivElement | null>;
}

function formatTime(seconds: number): string {
  const s = Math.floor(seconds);
  const m = Math.floor(s / 60);
  const remainder = s % 60;
  return `${m}:${remainder.toString().padStart(2, "0")}`;
}

/** Extract transition info */
function getTransition(segment: TimelineSegment): Transition {
  if (typeof segment.transition === "object" && segment.transition !== null) {
    return segment.transition as Transition;
  }
  const raw = (typeof segment.transition === "string" ? segment.transition : "cut");
  return { type: raw as Transition["type"], duration: 0 };
}

/** Apply transition CSS to outgoing and incoming elements */
function applyTransitionStyles(
  outgoing: HTMLVideoElement | null,
  incoming: HTMLVideoElement | null,
  overlay: HTMLDivElement | null,
  type: string,
  progress: number // 0 to 1
) {
  if (!incoming) return;

  switch (type) {
    case "crossfade":
      if (outgoing) {
        outgoing.style.opacity = String(1 - progress);
        outgoing.style.zIndex = "10";
      }
      incoming.style.opacity = String(progress);
      incoming.style.zIndex = "11";
      incoming.style.filter = "";
      incoming.style.clipPath = "";
      incoming.style.transform = "";
      break;

    case "fade_to_black":
    case "fade_to_white": {
      const color = type === "fade_to_black" ? "black" : "white";
      if (overlay) {
        overlay.style.display = "block";
        overlay.style.backgroundColor = color;
        if (progress < 0.5) {
          // First half: fade overlay in, outgoing visible
          overlay.style.opacity = String(progress * 2);
          if (outgoing) { outgoing.style.opacity = "1"; outgoing.style.zIndex = "10"; }
          incoming.style.opacity = "0";
          incoming.style.zIndex = "9";
        } else {
          // Second half: fade overlay out, incoming visible
          overlay.style.opacity = String((1 - progress) * 2);
          if (outgoing) { outgoing.style.opacity = "0"; outgoing.style.zIndex = "9"; }
          incoming.style.opacity = "1";
          incoming.style.zIndex = "10";
        }
      }
      incoming.style.filter = "";
      incoming.style.clipPath = "";
      incoming.style.transform = "";
      break;
    }

    case "wipe_left":
      if (outgoing) { outgoing.style.opacity = "1"; outgoing.style.zIndex = "10"; }
      incoming.style.opacity = "1";
      incoming.style.zIndex = "11";
      incoming.style.clipPath = `inset(0 ${(1 - progress) * 100}% 0 0)`;
      incoming.style.filter = "";
      incoming.style.transform = "";
      break;

    case "wipe_right":
      if (outgoing) { outgoing.style.opacity = "1"; outgoing.style.zIndex = "10"; }
      incoming.style.opacity = "1";
      incoming.style.zIndex = "11";
      incoming.style.clipPath = `inset(0 0 0 ${(1 - progress) * 100}%)`;
      incoming.style.filter = "";
      incoming.style.transform = "";
      break;

    case "zoom_in":
      if (outgoing) {
        const scale = 1 + progress * 0.5;
        outgoing.style.opacity = String(1 - progress);
        outgoing.style.transform = `scale(${scale})`;
        outgoing.style.zIndex = "10";
      }
      incoming.style.opacity = String(progress);
      incoming.style.zIndex = "11";
      incoming.style.filter = "";
      incoming.style.clipPath = "";
      incoming.style.transform = "";
      break;

    case "blur":
      if (outgoing) {
        outgoing.style.filter = `blur(${progress * 10}px)`;
        outgoing.style.opacity = String(1 - progress);
        outgoing.style.zIndex = "10";
      }
      incoming.style.filter = `blur(${(1 - progress) * 10}px)`;
      incoming.style.opacity = String(progress);
      incoming.style.zIndex = "11";
      incoming.style.clipPath = "";
      incoming.style.transform = "";
      break;

    default: // "cut"
      if (outgoing) { outgoing.style.opacity = "0"; outgoing.style.zIndex = "0"; }
      incoming.style.opacity = "1";
      incoming.style.zIndex = "10";
      incoming.style.filter = "";
      incoming.style.clipPath = "";
      incoming.style.transform = "";
      break;
  }
}

/** Reset all styles on a video element */
function resetVideoStyles(el: HTMLVideoElement) {
  el.style.opacity = "0";
  el.style.zIndex = "0";
  el.style.filter = "";
  el.style.clipPath = "";
  el.style.transform = "";
}

/** Map filter type + intensity to CSS filter string */
function getFilterCSS(segment: TimelineSegment): string {
  let css = "";

  // Apply filter if present
  const filter = segment.filter;
  if (filter && filter.type !== "none") {
    const intensity = filter.intensity ?? 1;
    const pct = intensity * 100;

    switch (filter.type) {
      case "grayscale": css = `grayscale(${pct}%)`; break;
      case "sepia": css = `sepia(${pct}%)`; break;
      case "high_contrast": css = `contrast(${100 + intensity * 50}%) saturate(${100 + intensity * 30}%)`; break;
      case "warm": css = `sepia(${pct * 0.3}%) saturate(${100 + intensity * 40}%) brightness(${100 + intensity * 5}%)`; break;
      case "cool": css = `saturate(${100 - intensity * 20}%) hue-rotate(${intensity * 20}deg) brightness(${100 + intensity * 5}%)`; break;
      case "vintage": css = `sepia(${pct * 0.4}%) saturate(${100 - intensity * 30}%) contrast(${100 + intensity * 10}%)`; break;
      case "dramatic": css = `contrast(${100 + intensity * 40}%) brightness(${100 - intensity * 15}%) saturate(${100 + intensity * 20}%)`; break;
    }
  }

  // Stack brightness adjustment if present
  const brightness = segment.brightness_adjustment;
  if (brightness && brightness !== 1.0) {
    const brightnessCss = `brightness(${brightness})`;
    css = css ? `${css} ${brightnessCss}` : brightnessCss;
  }

  return css;
}

export default function VideoPlayer({ proposal, clipUrls, onTimeUpdate, onPlayStateChange, videoVolume, playheadRef }: VideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const videosRef = useRef<Map<string, HTMLVideoElement>>(new Map());
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentSegmentIdx, setCurrentSegmentIdx] = useState(0);
  const [timelineTime, setTimelineTime] = useState(0);
  const [allLoaded, setAllLoaded] = useState(false);
  const rafRef = useRef<number | null>(null);
  const isPlayingRef = useRef(false);
  const segmentIdxRef = useRef(0);
  const transitionActiveRef = useRef(false);
  const progressBarRef = useRef<HTMLDivElement>(null);
  const timeDisplayRef = useRef<HTMLSpanElement>(null);

  const timeline = proposal?.timeline || [];
  const totalDuration = proposal?.total_duration || 0;

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

    for (const [url, el] of existingMap.entries()) {
      if (!urls.includes(url)) {
        el.pause();
        el.remove();
        existingMap.delete(url);
      }
    }

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
        video.style.transition = "none";
        video.src = url;
        container.appendChild(video);
        existingMap.set(url, video);

        video.addEventListener("loadeddata", () => {
          loadedCount++;
          if (loadedCount >= totalToLoad) setAllLoaded(true);
        }, { once: true });

        video.load();
      } else {
        loadedCount++;
        if (loadedCount >= totalToLoad) setAllLoaded(true);
      }
    }

    if (loadedCount >= totalToLoad) setAllLoaded(true);
  }, [proposal, timeline, uniqueClipUrls]);

  const showSegment = useCallback(
    (idx: number) => {
      const segment = timeline[idx];
      if (!segment) return;

      const url = getSegmentUrl(segment);
      const map = videosRef.current;
      const filterCss = getFilterCSS(segment);

      for (const [vUrl, el] of map.entries()) {
        if (vUrl === url) {
          el.style.opacity = "1";
          el.style.zIndex = "10";
          el.style.filter = filterCss;
          el.style.clipPath = "";
          el.style.transform = "";
        } else {
          resetVideoStyles(el);
          el.pause();
        }
      }

      // Hide overlay
      if (overlayRef.current) {
        overlayRef.current.style.display = "none";
      }
    },
    [timeline, getSegmentUrl]
  );

  // Tick function ref
  const tickFnRef = useRef<() => void>(() => {});
  const lastStateUpdateRef = useRef(0);

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

    // If the clip reached its own natural end before hitting segment.end
    // (the source file is shorter than the segment asks for), treat the
    // segment as finished instead of replaying the clip from 0.
    const clipEndedShort = video.ended || (video.duration && video.currentTime >= video.duration - 0.05);

    if (clipEndedShort && video.currentTime < segment.end - 0.15) {
      const nextIdx = idx + 1;
      if (nextIdx < timeline.length) {
        transitionActiveRef.current = false;
        segmentIdxRef.current = nextIdx;
        setCurrentSegmentIdx(nextIdx);
        showSegment(nextIdx);
        const nextSeg = timeline[nextIdx];
        const nextUrl = getSegmentUrl(nextSeg);
        const nextVideo = videosRef.current.get(nextUrl);
        if (nextVideo) {
          nextVideo.currentTime = nextSeg.start;
          nextVideo.play().catch(() => {});
        }
        rafRef.current = requestAnimationFrame(() => tickFnRef.current());
        return;
      } else {
        // Last segment and clip ended -- stop playback
        video.pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
        setTimelineTime(totalDuration);
        if (onTimeUpdate) onTimeUpdate(totalDuration);
        return;
      }
    }

    // Only resume a paused clip if it hasn't ended (avoid replay-from-0 loop)
    if (video.paused && isPlayingRef.current && !video.ended) {
      video.play().catch(() => {});
    }

    const clipProgress = Math.max(0, video.currentTime - segment.start);
    const timelinePos = segment.position_in_timeline + clipProgress;
    const clamped = Math.max(0, Math.min(timelinePos, totalDuration));

    // Direct DOM updates
    const pct = totalDuration > 0 ? (clamped / totalDuration) * 100 : 0;
    if (progressBarRef.current) progressBarRef.current.style.width = `${pct}%`;
    if (timeDisplayRef.current) {
      const s = Math.floor(clamped);
      const m = Math.floor(s / 60);
      const r = s % 60;
      timeDisplayRef.current.textContent = `${m}:${r.toString().padStart(2, "0")} / ${formatTime(totalDuration)}`;
    }
    if (playheadRef?.current) playheadRef.current.style.left = `${pct}%`;

    const now = performance.now();
    if (now - lastStateUpdateRef.current > 200) {
      lastStateUpdateRef.current = now;
      setTimelineTime(clamped);
      if (onTimeUpdate) onTimeUpdate(clamped);
    }

    // Check for transition start (approaching segment end)
    const nextIdx = idx + 1;
    if (nextIdx < timeline.length) {
      const nextSeg = timeline[nextIdx];
      const nextTransition = getTransition(nextSeg);
      const segEnd = segment.end;
      const transitionDuration = nextTransition.type !== "cut" ? nextTransition.duration : 0;

      // If we're within transition duration of segment end, start transition
      if (transitionDuration > 0 && video.currentTime >= segEnd - transitionDuration && !transitionActiveRef.current) {
        transitionActiveRef.current = true;
        // Start playing incoming clip
        const nextUrl = getSegmentUrl(nextSeg);
        const nextVideo = videosRef.current.get(nextUrl);
        if (nextVideo) {
          nextVideo.currentTime = nextSeg.start;
          nextVideo.play().catch(() => {});
        }
      }

      // Apply transition progress
      if (transitionActiveRef.current && transitionDuration > 0) {
        const timeIntoTransition = video.currentTime - (segEnd - transitionDuration);
        const progress = Math.max(0, Math.min(1, timeIntoTransition / transitionDuration));
        const nextUrl = getSegmentUrl(nextSeg);
        const nextVideo = videosRef.current.get(nextUrl) || null;
        applyTransitionStyles(video, nextVideo, overlayRef.current, nextTransition.type, progress);
      }

      // Segment boundary
      if (video.currentTime >= segEnd - 0.15) {
        video.pause();
        transitionActiveRef.current = false;
        segmentIdxRef.current = nextIdx;
        setCurrentSegmentIdx(nextIdx);
        showSegment(nextIdx);
        const nextUrl = getSegmentUrl(nextSeg);
        const nextVideo = videosRef.current.get(nextUrl);
        if (nextVideo) {
          // If transition was playing, it's already at start; otherwise seek
          if (getTransition(nextSeg).type === "cut" || getTransition(nextSeg).duration === 0) {
            nextVideo.currentTime = nextSeg.start;
          }
          nextVideo.play().catch(() => {});
        }
      }
    } else {
      // Last segment -- check end.
      if (video.currentTime >= segment.end - 0.15) {
        video.pause();
        isPlayingRef.current = false;
        setIsPlaying(false);
        setTimelineTime(totalDuration);
        if (onTimeUpdate) onTimeUpdate(totalDuration);
        return;
      }
    }

    rafRef.current = requestAnimationFrame(() => tickFnRef.current());
  };

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

  // Notify parent of play state changes
  useEffect(() => {
    onPlayStateChange?.(isPlaying);
  }, [isPlaying, onPlayStateChange]);

  // Apply external video volume control
  useEffect(() => {
    if (videoVolume === undefined) return;
    const idx = segmentIdxRef.current;
    const segment = timeline[idx];
    if (!segment) return;
    const url = getSegmentUrl(segment);
    const video = videosRef.current.get(url);
    if (video) {
      video.volume = Math.max(0, Math.min(1, videoVolume));
    }
  }, [videoVolume, timeline, getSegmentUrl]);

  const togglePlay = () => {
    if (!proposal || !allLoaded) return;

    if (isPlaying) {
      const segment = timeline[currentSegmentIdx];
      if (segment) {
        const url = getSegmentUrl(segment);
        const video = videosRef.current.get(url);
        if (video) video.pause();
      }
      setIsPlaying(false);
    } else {
      const lastSeg = timeline[timeline.length - 1];
      if (lastSeg && currentSegmentIdx >= timeline.length - 1) {
        const url = getSegmentUrl(lastSeg);
        const video = videosRef.current.get(url);
        if (video && video.currentTime >= lastSeg.end - 0.1) {
          setCurrentSegmentIdx(0);
          segmentIdxRef.current = 0;
          transitionActiveRef.current = false;
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

        const curSeg = timeline[currentSegmentIdx];
        if (curSeg) {
          const curUrl = getSegmentUrl(curSeg);
          const curVideo = videosRef.current.get(curUrl);
          if (curVideo) curVideo.pause();
        }

        setCurrentSegmentIdx(i);
        segmentIdxRef.current = i;
        transitionActiveRef.current = false;
        setTimelineTime(targetTime);
        showSegment(i);

        const url = getSegmentUrl(seg);
        const video = videosRef.current.get(url);
        if (video) video.currentTime = seekTo;
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
    transitionActiveRef.current = false;

    for (const [, el] of videosRef.current.entries()) {
      el.pause();
      resetVideoStyles(el);
    }

    if (overlayRef.current) overlayRef.current.style.display = "none";

    if (proposal && timeline.length > 0 && allLoaded) {
      showSegment(0);
      const firstSeg = timeline[0];
      const url = getSegmentUrl(firstSeg);
      const video = videosRef.current.get(url);
      if (video) video.currentTime = firstSeg.start;
    }
  }, [proposal, allLoaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const progressPct = totalDuration > 0 ? (timelineTime / totalDuration) * 100 : 0;

  return (
    <div className="flex flex-col h-full gap-2">
      <div className="relative rounded-xl overflow-hidden bg-black flex-1 cursor-pointer" onClick={togglePlay}>
        {/* Container for video elements */}
        <div ref={containerRef} className="absolute inset-0" />

        {/* Transition overlay (for fade_to_black/white) */}
        <div
          ref={overlayRef}
          className="absolute inset-0 pointer-events-none z-20"
          style={{ display: "none", opacity: 0 }}
        />

        {/* Loading overlay */}
        {!allLoaded && proposal && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/70 z-30">
            <Loader size="md" />
          </div>
        )}
        {!proposal && (
          <div className="absolute inset-0 flex items-center justify-center z-30">
            <p className="text-white/30 text-sm">Select a proposal to preview</p>
          </div>
        )}
        {/* Play overlay icon */}
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
