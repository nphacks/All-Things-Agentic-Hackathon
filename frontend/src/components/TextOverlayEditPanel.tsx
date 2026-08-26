import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TextOverlay } from "../types";

interface TextOverlayEditPanelProps {
  overlay: TextOverlay;
  position: { x: number; y: number };
  totalDuration: number;
  onUpdate: (overlay: TextOverlay) => void;
  onDelete: (id: string) => void;
  onClose: () => void;
}

const TYPES: TextOverlay["type"][] = ["title", "lower_third", "caption", "end_card"];
const POSITIONS: TextOverlay["position"][] = ["center", "lower", "upper"];
const FONT_SIZES: TextOverlay["style"]["font_size"][] = ["small", "medium", "large"];
const BACKGROUNDS: TextOverlay["style"]["background"][] = ["none", "semi", "solid"];
const ANIMATIONS: TextOverlay["animation"][] = ["fade", "slide", "none"];

const TYPE_LABELS: Record<TextOverlay["type"], string> = {
  title: "Title",
  lower_third: "Lower 3rd",
  caption: "Caption",
  end_card: "End Card",
};

export default function TextOverlayEditPanel({
  overlay,
  position,
  totalDuration,
  onUpdate,
  onDelete,
  onClose,
}: TextOverlayEditPanelProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const width = 260;
  const margin = 8;

  // Panel position (draggable). Initialized near the click, then clamped to the
  // viewport once we know the panel's real height so it never gets cut off.
  const [pos, setPos] = useState<{ x: number; y: number }>({
    x: Math.max(margin, Math.min(position.x - width / 2, window.innerWidth - width - margin)),
    y: Math.max(margin, position.y - 20),
  });

  // After first render, measure the panel and clamp so the bottom stays on screen.
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const h = el.offsetHeight;
    const maxY = Math.max(margin, window.innerHeight - h - margin);
    const maxX = Math.max(margin, window.innerWidth - width - margin);
    setPos((prev) => ({
      x: Math.max(margin, Math.min(prev.x, maxX)),
      y: Math.max(margin, Math.min(prev.y, maxY)),
    }));
    // Run once on mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Dragging via the header. Uses refs during the move to avoid re-render thrash.
  const dragRef = useRef<{ startX: number; startY: number; originX: number; originY: number } | null>(null);

  const handleDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    dragRef.current = { startX: e.clientX, startY: e.clientY, originX: pos.x, originY: pos.y };

    const handleMove = (ev: MouseEvent) => {
      if (!dragRef.current) return;
      const dx = ev.clientX - dragRef.current.startX;
      const dy = ev.clientY - dragRef.current.startY;
      const h = panelRef.current?.offsetHeight ?? 0;
      const maxX = Math.max(margin, window.innerWidth - width - margin);
      const maxY = Math.max(margin, window.innerHeight - h - margin);
      setPos({
        x: Math.max(margin, Math.min(dragRef.current.originX + dx, maxX)),
        y: Math.max(margin, Math.min(dragRef.current.originY + dy, maxY)),
      });
    };
    const handleUp = () => {
      dragRef.current = null;
      document.removeEventListener("mousemove", handleMove);
      document.removeEventListener("mouseup", handleUp);
    };
    document.addEventListener("mousemove", handleMove);
    document.addEventListener("mouseup", handleUp);
  };

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

  const patch = (partial: Partial<TextOverlay>) => onUpdate({ ...overlay, ...partial });
  const patchStyle = (partial: Partial<TextOverlay["style"]>) =>
    onUpdate({ ...overlay, style: { ...overlay.style, ...partial } });

  const panel = (
    <div ref={panelRef} className="fixed z-[9999]" style={{ left: pos.x, top: pos.y, width }}>
      <div
        className="glass-strong rounded-xl shadow-2xl flex flex-col"
        style={{ maxHeight: "calc(100vh - 16px)" }}
      >
        {/* Header -- drag handle */}
        <div
          onMouseDown={handleDragStart}
          className="flex items-center justify-between px-3 py-2 border-b border-white/10 cursor-move select-none flex-shrink-0"
        >
          <span className="text-[11px] text-white/60 font-medium">Edit Text Overlay</span>
          <button
            onMouseDown={(e) => e.stopPropagation()}
            onClick={onClose}
            className="text-white/40 hover:text-white/80 text-xs"
            aria-label="Close"
          >
            x
          </button>
        </div>

        {/* Scrollable body */}
        <div className="p-3 space-y-3 overflow-y-auto">
        {/* Text */}
        <div className="space-y-1">
          <label className="text-[10px] text-white/40">Text</label>
          <textarea
            value={overlay.text}
            onChange={(e) => patch({ text: e.target.value })}
            rows={2}
            autoFocus
            className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1.5 text-[11px] text-white placeholder-white/30 focus:outline-none focus:border-green-400/50 resize-none"
          />
        </div>

        {/* Type */}
        <div className="space-y-1">
          <label className="text-[10px] text-white/40">Type</label>
          <div className="flex flex-wrap gap-1">
            {TYPES.map((t) => (
              <button
                key={t}
                onClick={() => patch({ type: t })}
                className={`px-2 py-0.5 rounded text-[9px] border transition-all ${
                  overlay.type === t
                    ? "bg-green-500/20 text-green-400 border-green-500/40"
                    : "bg-dark-300 text-white/40 border-white/10 hover:border-white/20"
                }`}
              >
                {TYPE_LABELS[t]}
              </button>
            ))}
          </div>
        </div>

        {/* Timing */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">Start (s)</label>
            <input
              type="number"
              min={0}
              max={totalDuration}
              step={0.1}
              value={overlay.start_time}
              onChange={(e) => {
                const start = Math.max(0, Math.min(Number(e.target.value), totalDuration));
                patch({ start_time: start, end_time: Math.max(start + 0.5, overlay.end_time) });
              }}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1 text-[11px] text-white focus:outline-none focus:border-green-400/50"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">End (s)</label>
            <input
              type="number"
              min={0}
              max={totalDuration}
              step={0.1}
              value={overlay.end_time}
              onChange={(e) => {
                const end = Math.max(overlay.start_time + 0.5, Math.min(Number(e.target.value), totalDuration));
                patch({ end_time: end });
              }}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1 text-[11px] text-white focus:outline-none focus:border-green-400/50"
            />
          </div>
        </div>

        {/* Position */}
        <div className="space-y-1">
          <label className="text-[10px] text-white/40">Position</label>
          <div className="flex gap-1">
            {POSITIONS.map((p) => (
              <button
                key={p}
                onClick={() => patch({ position: p })}
                className={`flex-1 px-2 py-0.5 rounded text-[9px] border capitalize transition-all ${
                  overlay.position === p
                    ? "bg-green-500/20 text-green-400 border-green-500/40"
                    : "bg-dark-300 text-white/40 border-white/10 hover:border-white/20"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {/* Style: size + background + color */}
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">Size</label>
            <select
              value={overlay.style.font_size}
              onChange={(e) => patchStyle({ font_size: e.target.value as TextOverlay["style"]["font_size"] })}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1 text-[10px] text-white focus:outline-none focus:border-green-400/50 capitalize"
            >
              {FONT_SIZES.map((s) => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">Background</label>
            <select
              value={overlay.style.background}
              onChange={(e) => patchStyle({ background: e.target.value as TextOverlay["style"]["background"] })}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1 text-[10px] text-white focus:outline-none focus:border-green-400/50 capitalize"
            >
              {BACKGROUNDS.map((b) => (
                <option key={b} value={b}>{b}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2 items-end">
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">Color</label>
            <input
              type="color"
              value={overlay.style.color || "#ffffff"}
              onChange={(e) => patchStyle({ color: e.target.value })}
              className="w-full h-7 rounded-lg bg-dark-300 border border-white/10 cursor-pointer"
            />
          </div>
          <div className="space-y-1">
            <label className="text-[10px] text-white/40">Animation</label>
            <select
              value={overlay.animation}
              onChange={(e) => patch({ animation: e.target.value as TextOverlay["animation"] })}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-2 py-1 text-[10px] text-white focus:outline-none focus:border-green-400/50 capitalize"
            >
              {ANIMATIONS.map((a) => (
                <option key={a} value={a}>{a}</option>
              ))}
            </select>
          </div>
        </div>

        <button
          onClick={() => onDelete(overlay.id)}
          className="w-full px-2 py-1 rounded bg-red-500/10 text-red-400 text-[10px] border border-red-500/20 hover:bg-red-500/20 transition-all"
        >
          Delete Overlay
        </button>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
