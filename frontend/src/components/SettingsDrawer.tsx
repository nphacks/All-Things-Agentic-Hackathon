import type { JobSettings } from "../types";
import BriefInput from "./BriefInput";
import MoodPresets from "./MoodPresets";
import SettingsPanel from "./SettingsPanel";

interface SettingsDrawerProps {
  isOpen: boolean;
  onClose: () => void;
  brief: string;
  onBriefChange: (value: string) => void;
  settings: JobSettings;
  onSettingsChange: (settings: JobSettings) => void;
}

export default function SettingsDrawer({
  isOpen,
  onClose,
  brief,
  onBriefChange,
  settings,
  onSettingsChange,
}: SettingsDrawerProps) {
  return (
    <>
      {/* Backdrop */}
      {isOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={onClose}
        />
      )}

      {/* Drawer */}
      <div
        className={`
          fixed top-0 right-0 h-full w-[380px] max-w-[90vw] z-50
          glass-strong rounded-l-2xl
          transform transition-transform duration-300 ease-in-out
          ${isOpen ? "translate-x-0" : "translate-x-full"}
        `}
      >
        <div className="flex flex-col h-full p-6 overflow-y-auto">
          {/* Header */}
          <div className="flex items-center justify-between mb-6">
            <h2 className="text-sm font-semibold text-white/80 uppercase tracking-wide">
              Project Settings
            </h2>
            <button
              onClick={onClose}
              className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-white/70 hover:bg-white/5"
              aria-label="Close settings"
            >
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Mood Presets */}
          <div className="mb-4">
            <MoodPresets onSelect={onBriefChange} />
          </div>

          {/* Brief */}
          <div className="mb-5">
            <BriefInput value={brief} onChange={onBriefChange} />
          </div>

          {/* Settings */}
          <SettingsPanel settings={settings} onChange={onSettingsChange} />
        </div>
      </div>
    </>
  );
}
