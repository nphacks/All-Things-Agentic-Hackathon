import type { JobSettings } from "../types";

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
    </div>
  );
}
