import { useState, useRef, useEffect, useCallback } from "react";
import { createPortal } from "react-dom";

/** A track result from Jamendo search */
export interface MusicTrack {
  id: string;
  name: string;
  artist_name: string;
  duration: number;
  audio: string;
  tags: string[];
}

/** Current music selection data */
export interface MusicSelection {
  track_id: string;
  title: string;
  artist: string;
  url: string;
  preview_url: string;
  duration: number;
  tags?: string[];
  reason?: string;
  placement?: {
    start_time: number;
    end_time: number;
    track_start: number;
  };
  volume_keyframes?: { time: number; volume: number; transition: string; fade_duration?: number }[];
}

interface MusicPanelProps {
  triggerRect: DOMRect | null;
  currentMusic: MusicSelection | null;
  onFeedbackSubmit: (feedback: string) => Promise<void>;
  onSearchQuery: (query: string) => Promise<MusicTrack[]>;
  onTrackSelect: (track: MusicTrack) => void;
  onClose: () => void;
  isRefining?: boolean;
}

type PanelMode = "feedback" | "search";

export default function MusicPanel({
  triggerRect,
  currentMusic,
  onFeedbackSubmit,
  onSearchQuery,
  onTrackSelect,
  onClose,
  isRefining = false,
}: MusicPanelProps) {
  const [mode, setMode] = useState<PanelMode>("feedback");
  const [feedback, setFeedback] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<MusicTrack[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [previewingId, setPreviewingId] = useState<string | null>(null);

  const panelRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const dragRef = useRef<{ isDragging: boolean; startX: number; startY: number; offsetX: number; offsetY: number }>({
    isDragging: false,
    startX: 0,
    startY: 0,
    offsetX: 0,
    offsetY: 0,
  });

  // Panel position state
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  // Calculate initial position based on trigger element
  useEffect(() => {
    if (!triggerRect) {
      // Center on screen as fallback
      setPosition({
        x: window.innerWidth / 2 - 180,
        y: window.innerHeight / 2 - 200,
      });
      return;
    }

    const panelWidth = 360;
    const panelHeight = 400;
    const padding = 12;

    // Calculate available space in each direction
    const spaceRight = window.innerWidth - triggerRect.right;
    const spaceLeft = triggerRect.left;
    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const spaceAbove = triggerRect.top;

    let x: number;
    let y: number;

    // Horizontal: prefer right, fallback to left, then center
    if (spaceRight >= panelWidth + padding) {
      x = triggerRect.right + padding;
    } else if (spaceLeft >= panelWidth + padding) {
      x = triggerRect.left - panelWidth - padding;
    } else {
      x = Math.max(padding, (window.innerWidth - panelWidth) / 2);
    }

    // Vertical: prefer below, fallback to above, then center
    if (spaceBelow >= panelHeight + padding) {
      y = triggerRect.bottom + padding;
    } else if (spaceAbove >= panelHeight + padding) {
      y = triggerRect.top - panelHeight - padding;
    } else {
      y = Math.max(padding, (window.innerHeight - panelHeight) / 2);
    }

    // Clamp to viewport
    x = Math.max(padding, Math.min(x, window.innerWidth - panelWidth - padding));
    y = Math.max(padding, Math.min(y, window.innerHeight - panelHeight - padding));

    setPosition({ x, y });
  }, [triggerRect]);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    // Delay to prevent the opening click from immediately closing
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);

    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.MouseEvent) => {
    if (!position) return;
    dragRef.current = {
      isDragging: true,
      startX: e.clientX,
      startY: e.clientY,
      offsetX: position.x,
      offsetY: position.y,
    };
    e.preventDefault();
  }, [position]);

  useEffect(() => {
    const handleMouseMove = (e: MouseEvent) => {
      if (!dragRef.current.isDragging) return;
      const dx = e.clientX - dragRef.current.startX;
      const dy = e.clientY - dragRef.current.startY;
      setPosition({
        x: dragRef.current.offsetX + dx,
        y: dragRef.current.offsetY + dy,
      });
    };

    const handleMouseUp = () => {
      dragRef.current.isDragging = false;
    };

    document.addEventListener("mousemove", handleMouseMove);
    document.addEventListener("mouseup", handleMouseUp);
    return () => {
      document.removeEventListener("mousemove", handleMouseMove);
      document.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  // Cleanup audio on unmount
  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause();
        audioRef.current.src = "";
      }
    };
  }, []);

  const handleFeedbackSubmit = async () => {
    if (!feedback.trim()) return;
    await onFeedbackSubmit(feedback.trim());
    setFeedback("");
  };

  const handleSearch = async () => {
    if (!searchQuery.trim()) return;
    setIsSearching(true);
    try {
      const results = await onSearchQuery(searchQuery.trim());
      setSearchResults(results);
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      handleSearch();
    }
  };

  const handlePreview = (track: MusicTrack) => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    if (previewingId === track.id) {
      // Stop preview
      audioRef.current.pause();
      setPreviewingId(null);
    } else {
      // Play preview
      audioRef.current.src = track.audio;
      audioRef.current.volume = 0.5;
      audioRef.current.play().catch(() => {});
      setPreviewingId(track.id);

      audioRef.current.onended = () => setPreviewingId(null);
    }
  };

  const handleTrackSelect = (track: MusicTrack) => {
    // Stop any preview
    if (audioRef.current) {
      audioRef.current.pause();
      setPreviewingId(null);
    }
    onTrackSelect(track);
  };

  if (!position) return null;

  const panel = (
    <div
      ref={panelRef}
      className="fixed z-[9999]"
      style={{ left: position.x, top: position.y, width: 360 }}
    >
      <div className="glass-strong rounded-xl overflow-hidden shadow-2xl">
        {/* Title bar (draggable) */}
        <div
          className="flex items-center justify-between px-4 py-2.5 border-b border-white/5 cursor-move select-none"
          onMouseDown={handleDragStart}
        >
          <span className="text-xs font-medium text-white/70">Background Music</span>
          <button
            onClick={onClose}
            className="w-5 h-5 flex items-center justify-center rounded text-white/40 hover:text-white/80 hover:bg-white/10 transition-all"
            aria-label="Close music panel"
          >
            x
          </button>
        </div>

        {/* Current music info */}
        {currentMusic && (
          <div className="px-4 py-2 border-b border-white/5">
            <div className="text-xs text-white/50">Current track</div>
            <div className="text-sm text-white/90 truncate">{currentMusic.title}</div>
            <div className="text-xs text-white/40">{currentMusic.artist}</div>
          </div>
        )}

        {/* Mode tabs */}
        <div className="flex border-b border-white/5">
          <button
            onClick={() => setMode("feedback")}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-all ${
              mode === "feedback"
                ? "text-green-400 border-b-2 border-green-400"
                : "text-white/40 hover:text-white/60"
            }`}
          >
            Feedback
          </button>
          <button
            onClick={() => setMode("search")}
            className={`flex-1 px-4 py-2 text-xs font-medium transition-all ${
              mode === "search"
                ? "text-green-400 border-b-2 border-green-400"
                : "text-white/40 hover:text-white/60"
            }`}
          >
            Search
          </button>
        </div>

        {/* Panel content */}
        <div className="p-4">
          {mode === "feedback" ? (
            <div className="space-y-3">
              <textarea
                value={feedback}
                onChange={(e) => setFeedback(e.target.value)}
                placeholder="Too slow, need something more upbeat..."
                rows={3}
                className="w-full rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-green-400/50 resize-none"
              />
              <button
                onClick={handleFeedbackSubmit}
                disabled={!feedback.trim() || isRefining}
                className="w-full px-4 py-2 rounded-lg bg-green-500/20 text-green-400 text-xs font-medium border border-green-500/30 hover:bg-green-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
              >
                {isRefining ? "Finding new track..." : "Get New Suggestion"}
              </button>
              {isRefining && (
                <p className="text-[10px] text-white/30 text-center">
                  Agent is searching for a better match...
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Search input */}
              <div className="flex gap-2">
                <input
                  type="text"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  onKeyDown={handleSearchKeyDown}
                  placeholder="Search Jamendo..."
                  className="flex-1 rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-green-400/50"
                />
                <button
                  onClick={handleSearch}
                  disabled={!searchQuery.trim() || isSearching}
                  className="px-3 py-2 rounded-lg bg-dark-300 border border-white/10 text-xs text-white/70 hover:border-green-400/50 hover:text-green-400 transition-all disabled:opacity-40"
                >
                  {isSearching ? "..." : "Go"}
                </button>
              </div>

              {/* Results list */}
              <div className="max-h-[240px] overflow-y-auto space-y-1.5 scrollbar-thin">
                {searchResults.length === 0 && !isSearching && (
                  <p className="text-[10px] text-white/30 text-center py-4">
                    Search for tracks by mood, genre, or keywords
                  </p>
                )}
                {searchResults.map((track) => (
                  <div
                    key={track.id}
                    className="flex items-center gap-2 p-2 rounded-lg bg-dark-300/50 border border-white/5 hover:border-green-400/20 transition-all group"
                  >
                    {/* Preview button */}
                    <button
                      onClick={() => handlePreview(track)}
                      className={`w-7 h-7 flex-shrink-0 flex items-center justify-center rounded-full border transition-all ${
                        previewingId === track.id
                          ? "bg-green-500/20 border-green-400/50 text-green-400"
                          : "border-white/10 text-white/40 hover:border-green-400/30 hover:text-green-400"
                      }`}
                      aria-label={previewingId === track.id ? "Stop preview" : "Preview track"}
                    >
                      <span className="text-[10px]">{previewingId === track.id ? "||" : ">"}</span>
                    </button>

                    {/* Track info */}
                    <div className="flex-1 min-w-0">
                      <div className="text-xs text-white/80 truncate">{track.name}</div>
                      <div className="text-[10px] text-white/40 truncate">
                        {track.artist_name} -- {Math.floor(track.duration / 60)}:{String(track.duration % 60).padStart(2, "0")}
                      </div>
                      {track.tags.length > 0 && (
                        <div className="flex gap-1 mt-0.5 flex-wrap">
                          {track.tags.slice(0, 3).map((tag) => (
                            <span key={tag} className="text-[9px] px-1.5 py-0.5 rounded bg-white/5 text-white/30">
                              {tag}
                            </span>
                          ))}
                        </div>
                      )}
                    </div>

                    {/* Select button */}
                    <button
                      onClick={() => handleTrackSelect(track)}
                      className="px-2 py-1 rounded text-[10px] text-white/40 border border-white/10 hover:border-green-400/40 hover:text-green-400 transition-all opacity-0 group-hover:opacity-100"
                    >
                      Use
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
