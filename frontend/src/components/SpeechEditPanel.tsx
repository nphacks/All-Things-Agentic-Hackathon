import { useState, useRef, useEffect } from "react";
import { createPortal } from "react-dom";
import type { SpeechChunk } from "./AudioTracks";
import { renderSpeechChunk } from "../services/api";

interface SpeechEditPanelProps {
  chunk: SpeechChunk;
  position: { x: number; y: number };
  voiceName: string;
  projectId: string;
  onUpdate: (updated: SpeechChunk) => void;
  onDelete: (chunkId: string) => void;
  onClose: () => void;
}

export default function SpeechEditPanel({
  chunk,
  position,
  voiceName,
  projectId,
  onUpdate,
  onDelete,
  onClose,
}: SpeechEditPanelProps) {
  const [text, setText] = useState(chunk.text);
  const [rate, setRate] = useState(chunk.speaking_rate ?? 1.0);
  const [isRendering, setIsRendering] = useState(false);
  const [renderError, setRenderError] = useState<string | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const timer = setTimeout(() => {
      document.addEventListener("mousedown", handleClickOutside);
    }, 100);
    return () => {
      clearTimeout(timer);
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, [onClose]);

  // Clamp position to viewport
  const panelWidth = 280;
  const panelHeight = 240;
  const x = Math.max(8, Math.min(position.x - panelWidth / 2, window.innerWidth - panelWidth - 8));
  const y = Math.max(8, Math.min(position.y - panelHeight - 12, window.innerHeight - panelHeight - 8));

  const handleReRender = async () => {
    if (!text.trim()) return;
    setIsRendering(true);
    setRenderError(null);
    try {
      const result = await renderSpeechChunk(
        projectId,
        chunk.chunk_id,
        text.trim(),
        voiceName,
        rate,
      );
      // Update the chunk with new data
      onUpdate({
        ...chunk,
        text: text.trim(),
        speaking_rate: rate,
        gcs_url: result.gcs_url,
        audio_duration: result.audio_duration,
        end_time: chunk.start_time + result.audio_duration,
      });
    } catch (err) {
      setRenderError(err instanceof Error ? err.message : "Render failed");
    } finally {
      setIsRendering(false);
    }
  };

  const handleDelete = () => {
    onDelete(chunk.chunk_id);
    onClose();
  };

  const panel = (
    <div
      ref={panelRef}
      className="fixed z-[9999]"
      style={{ left: x, top: y, width: panelWidth }}
    >
      <div className="glass-strong rounded-xl overflow-hidden shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2 border-b border-white/5">
          <span className="text-[10px] text-white/50">Edit Speech Chunk</span>
          <button
            onClick={onClose}
            className="w-4 h-4 flex items-center justify-center rounded text-white/40 hover:text-white/80 transition-all text-xs"
            aria-label="Close"
          >
            x
          </button>
        </div>

        <div className="p-3 space-y-3">
          {/* Text area */}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            className="w-full rounded-lg bg-dark-300 border border-white/10 px-2.5 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-green-400/50 resize-none"
            placeholder="Speech text..."
          />

          {/* Speaking rate */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-[10px] text-white/40">Rate</span>
              <span className="text-[10px] text-white/60">{rate.toFixed(1)}x</span>
            </div>
            <input
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={rate}
              onChange={(e) => setRate(Number(e.target.value))}
              className="w-full h-1 rounded-full appearance-none bg-dark-300 accent-green-400"
            />
          </div>

          {/* Error message */}
          {renderError && (
            <p className="text-[10px] text-red-400">{renderError}</p>
          )}

          {/* Actions */}
          <div className="flex items-center gap-2">
            <button
              onClick={handleReRender}
              disabled={isRendering || !text.trim()}
              className="flex-1 px-3 py-1.5 rounded-lg bg-green-500/20 text-green-400 text-[10px] font-medium border border-green-500/30 hover:bg-green-500/30 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {isRendering ? "Rendering..." : "Re-render"}
            </button>
            <button
              onClick={handleDelete}
              className="px-3 py-1.5 rounded-lg bg-red-500/10 text-red-400 text-[10px] border border-red-500/20 hover:bg-red-500/20 transition-all"
            >
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );

  return createPortal(panel, document.body);
}
