import { useState, useRef } from "react";
import type { JobSettings } from "../types";
import { renderSpeechChunk } from "../services/api";

interface SettingsPanelProps {
  settings: JobSettings;
  onChange: (settings: JobSettings) => void;
}

const VARIATION_OPTIONS = [
  { key: "pacing", label: "Pacing" },
  { key: "mood", label: "Mood" },
  { key: "story", label: "Story" },
  { key: "experimental", label: "Experimental" },
];

export default function SettingsPanel({ settings, onChange }: SettingsPanelProps) {
  const update = (partial: Partial<JobSettings>) => {
    onChange({ ...settings, ...partial });
  };

  const toggleVariation = (key: string) => {
    const current = settings.variations;
    const next = current.includes(key)
      ? current.filter((v) => v !== key)
      : [...current, key];
    update({ variations: next });
  };

  const [previewLoading, setPreviewLoading] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const handlePreviewVoice = async () => {
    setPreviewLoading(true);
    try {
      const result = await renderSpeechChunk(
        "voice-preview",
        "preview",
        "Hello, welcome to your edit.",
        settings.voice_name,
        settings.speaking_rate,
      );
      if (result.gcs_url) {
        if (audioRef.current) {
          audioRef.current.src = result.gcs_url;
          audioRef.current.play();
        }
      }
    } catch {
      // Silently fail preview
    } finally {
      setPreviewLoading(false);
    }
  };

  return (
    <div className="glass rounded-xl p-5 space-y-5">
      <h3 className="text-sm font-medium text-white/70">Settings</h3>

      {/* Duration */}
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <label htmlFor="min-dur" className="text-xs text-white/50">Min Duration (s)</label>
          <input
            id="min-dur"
            type="number"
            min={5}
            max={60}
            value={settings.min_duration}
            onChange={(e) => update({ min_duration: Number(e.target.value) })}
            className="w-full rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-green-400/50"
          />
        </div>
        <div className="space-y-1">
          <label htmlFor="max-dur" className="text-xs text-white/50">Max Duration (s)</label>
          <input
            id="max-dur"
            type="number"
            min={5}
            max={60}
            value={settings.max_duration}
            onChange={(e) => update({ max_duration: Number(e.target.value) })}
            className="w-full rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-green-400/50"
          />
        </div>
      </div>

      {/* Number of proposals */}
      <div className="space-y-1">
        <label htmlFor="num-proposals" className="text-xs text-white/50">Number of Proposals</label>
        <select
          id="num-proposals"
          value={settings.num_proposals}
          onChange={(e) => update({ num_proposals: Number(e.target.value) })}
          className="w-full rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-sm text-white focus:outline-none focus:border-green-400/50"
        >
          <option value={2}>2</option>
          <option value={3}>3</option>
          <option value={4}>4</option>
          <option value={5}>5</option>
        </select>
      </div>

      {/* Variations */}
      <div className="space-y-2">
        <span className="text-xs text-white/50">Variation Preferences</span>
        <div className="flex flex-wrap gap-2">
          {VARIATION_OPTIONS.map((opt) => {
            const isActive = settings.variations.includes(opt.key);
            return (
              <button
                key={opt.key}
                onClick={() => toggleVariation(opt.key)}
                className={`
                  px-3 py-1.5 rounded-lg text-xs font-medium transition-all
                  ${isActive
                    ? "bg-green-500/20 text-green-400 border border-green-500/40"
                    : "bg-dark-300 text-white/50 border border-white/10 hover:border-white/20"
                  }
                `}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
      </div>

      {/* Transitions toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Add Transitions</span>
        <button
          onClick={() => update({ add_transitions: !settings.add_transitions })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.add_transitions
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.add_transitions}
          aria-label="Add transitions between clips"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.add_transitions
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Filters toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Allow Filters</span>
        <button
          onClick={() => update({ allow_filters: !settings.allow_filters })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.allow_filters
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.allow_filters}
          aria-label="Allow visual filters on segments"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.allow_filters
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Brightness correction toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Auto Brightness</span>
        <button
          onClick={() => update({ auto_brightness: !settings.auto_brightness })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.auto_brightness
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.auto_brightness}
          aria-label="Auto-correct brightness between segments"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.auto_brightness
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Manage original audio toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Manage Original Audio</span>
        <button
          onClick={() => update({ manage_audio: !settings.manage_audio })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.manage_audio
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.manage_audio}
          aria-label="Manage original audio volume per segment"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.manage_audio
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Background music toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Add Background Music</span>
        <button
          onClick={() => update({ add_background_music: !settings.add_background_music })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.add_background_music
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.add_background_music}
          aria-label="Add background music to proposals"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.add_background_music
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Add Titles toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Add Titles</span>
        <button
          onClick={() => update({ add_titles: !settings.add_titles })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.add_titles
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.add_titles}
          aria-label="Let the agent add title cards, lower thirds, and end cards"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.add_titles
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Add Captions toggle */}
      <div className="flex items-center justify-between">
        <div className="flex flex-col">
          <span className="text-xs text-white/50">Add Captions</span>
          {settings.add_captions && !settings.add_voiceover && (
            <span className="text-[10px] text-gold-400/70">Requires voiceover to caption</span>
          )}
        </div>
        <button
          onClick={() => update({ add_captions: !settings.add_captions })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.add_captions
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.add_captions}
          aria-label="Generate captions timed to the voiceover"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.add_captions
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Voiceover toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs text-white/50">Add Voiceover</span>
        <button
          onClick={() => update({ add_voiceover: !settings.add_voiceover })}
          className={`
            w-10 h-5 rounded-full transition-all relative
            ${settings.add_voiceover
              ? "bg-green-500/40 border border-green-400/50"
              : "bg-dark-300 border border-white/10"
            }
          `}
          role="switch"
          aria-checked={settings.add_voiceover}
          aria-label="Add voiceover narration to proposals"
        >
          <div
            className={`
              w-3.5 h-3.5 rounded-full absolute top-[2px] transition-all
              ${settings.add_voiceover
                ? "left-[22px] bg-green-400"
                : "left-[3px] bg-white/30"
              }
            `}
          />
        </button>
      </div>

      {/* Voice settings (only when voiceover enabled) */}
      {settings.add_voiceover && (
        <div className="space-y-3 pl-2 border-l border-green-500/20">
          {/* Voice selector */}
          <div className="space-y-1">
            <label htmlFor="voice-select" className="text-xs text-white/50">Voice</label>
            <div className="flex gap-2">
              <select
                id="voice-select"
                value={settings.voice_name}
                onChange={(e) => update({ voice_name: e.target.value })}
                className="flex-1 rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-xs text-white focus:outline-none focus:border-green-400/50"
              >
                <option value="en-US-Journey-D">Journey Male - warm, conversational</option>
                <option value="en-US-Journey-F">Journey Female - warm, conversational</option>
                <option value="en-US-Neural2-D">Neural2 Male - clear, professional</option>
                <option value="en-US-Neural2-C">Neural2 Female - clear, professional</option>
                <option value="en-US-Neural2-J">Neural2 Male - deep</option>
                <option value="en-US-Neural2-E">Neural2 Female - bright, energetic</option>
              </select>
              <button
                onClick={handlePreviewVoice}
                disabled={previewLoading}
                className="px-3 py-2 rounded-lg bg-dark-300 border border-white/10 text-xs text-white/70 hover:border-green-400/50 hover:text-green-400 transition-all disabled:opacity-50"
                aria-label="Preview selected voice"
              >
                {previewLoading ? "..." : "Preview"}
              </button>
            </div>
            <audio ref={audioRef} className="hidden" />
          </div>

          {/* Speaking rate slider */}
          <div className="space-y-1">
            <div className="flex items-center justify-between">
              <label htmlFor="speaking-rate" className="text-xs text-white/50">Speaking Rate</label>
              <span className="text-xs text-white/70">{settings.speaking_rate.toFixed(1)}x</span>
            </div>
            <input
              id="speaking-rate"
              type="range"
              min={0.5}
              max={2.0}
              step={0.1}
              value={settings.speaking_rate}
              onChange={(e) => update({ speaking_rate: Number(e.target.value) })}
              className="w-full h-1.5 rounded-full appearance-none bg-dark-300 accent-green-400"
            />
            <div className="flex justify-between text-[10px] text-white/30">
              <span>0.5x</span>
              <span>2.0x</span>
            </div>
          </div>

          {/* Speech context textarea */}
          <div className="space-y-1">
            <label htmlFor="speech-context" className="text-xs text-white/50">Speech Notes</label>
            <textarea
              id="speech-context"
              value={settings.speech_context}
              onChange={(e) => update({ speech_context: e.target.value })}
              placeholder="What should the voiceover say? Key points, exact phrases, tone..."
              rows={3}
              className="w-full rounded-lg bg-dark-300 border border-white/10 px-3 py-2 text-xs text-white placeholder-white/30 focus:outline-none focus:border-green-400/50 resize-none"
            />
          </div>
        </div>
      )}
    </div>
  );
}
