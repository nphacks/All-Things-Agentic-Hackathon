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
    </div>
  );
}
