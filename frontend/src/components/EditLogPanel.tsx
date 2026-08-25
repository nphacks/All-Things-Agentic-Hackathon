import { useState } from "react";

/** A single edit log entry */
export interface EditLogEntry {
  action: string;
  clip?: string;
  clips?: string[];
  track?: string;
  artist?: string;
  summary?: string;
  reason?: string;
}

interface EditLogPanelProps {
  entries: EditLogEntry[];
  defaultExpanded?: boolean;
}

/** Get a text icon for a log entry action type */
function getActionIcon(action: string): string {
  switch (action) {
    case "analyzed_clip": return "[A]";
    case "analyzed_audio": return "[A]";
    case "generated_proposal": return "[P]";
    case "skipped_clips": return "[X]";
    case "placed_transitions": return "[T]";
    case "generated_speech": return "[V]";
    case "selected_music": return "[N]";
    default: return "[*]";
  }
}

/** Get a color class for a log entry action type */
function getActionColor(action: string): string {
  switch (action) {
    case "analyzed_clip": return "text-blue-400/70";
    case "analyzed_audio": return "text-cyan-400/70";
    case "generated_proposal": return "text-green-400/70";
    case "skipped_clips": return "text-red-400/70";
    case "placed_transitions": return "text-purple-400/70";
    case "generated_speech": return "text-yellow-400/70";
    case "selected_music": return "text-pink-400/70";
    default: return "text-white/40";
  }
}

/** Format the description for a log entry */
function getDescription(entry: EditLogEntry): string {
  switch (entry.action) {
    case "analyzed_clip": {
      const clip = entry.clip ? entry.clip.split("/").pop()?.replace(/^[a-f0-9-]+_/, "") : "clip";
      return `Analyzed ${clip}: ${entry.summary || ""}`;
    }
    case "analyzed_audio": {
      const clip = entry.clip ? entry.clip.split("/").pop()?.replace(/^[a-f0-9-]+_/, "") : "clip";
      return `${clip} -- ${entry.summary || ""}`;
    }
    case "generated_proposal":
      return entry.summary || "Generated proposal";
    case "skipped_clips":
      return `Skipped: ${(entry.clips || []).join(", ")}`;
    case "placed_transitions":
      return entry.summary || "Added transitions";
    case "generated_speech":
      return entry.summary || "Generated voiceover";
    case "selected_music":
      return `Selected "${entry.track}"${entry.artist ? ` by ${entry.artist}` : ""}`;
    default:
      return entry.summary || entry.action;
  }
}

/** Get the reasoning/explanation for a log entry */
function getReason(entry: EditLogEntry): string | null {
  if (entry.action === "skipped_clips" && entry.reason) return entry.reason;
  if (entry.action === "selected_music" && entry.reason) return entry.reason;
  return null;
}

export default function EditLogPanel({ entries, defaultExpanded = false }: EditLogPanelProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);

  if (!entries || entries.length === 0) return null;

  return (
    <div className="rounded-xl mt-2 glass border border-white/5 overflow-hidden">
      {/* Header (click to expand/collapse) */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center justify-between px-4 py-2.5 hover:bg-white/5 transition-all"
      >
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-white/30 font-mono">{expanded ? "[-]" : "[+]"}</span>
          <span className="text-xs text-white/50 font-medium">AI Edit Log</span>
          <span className="text-[10px] text-white/30">{entries.length} decisions</span>
        </div>
        <span className="text-[10px] text-white/20">{expanded ? "collapse" : "expand"}</span>
      </button>

      {/* Entries */}
      {expanded && (
        <div className="px-4 pb-3 space-y-1.5 max-h-[300px] overflow-y-auto">
          {entries.map((entry, i) => {
            const reason = getReason(entry);
            return (
              <div key={i} className="flex gap-2 py-1 border-t border-white/3 first:border-t-0">
                <span className={`text-[10px] font-mono flex-shrink-0 w-6 ${getActionColor(entry.action)}`}>
                  {getActionIcon(entry.action)}
                </span>
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] text-white/60 leading-relaxed truncate">
                    {getDescription(entry)}
                  </p>
                  {reason && (
                    <p className="text-[10px] text-white/30 leading-relaxed mt-0.5 italic">
                      {reason}
                    </p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
