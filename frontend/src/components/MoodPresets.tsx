interface MoodPresetsProps {
  onSelect: (brief: string) => void;
}

const PRESETS: { key: string; label: string; brief: string }[] = [
  {
    key: "custom",
    label: "Custom",
    brief: "",
  },
  {
    key: "cinematic",
    label: "Cinematic",
    brief: "Create a cinematic, visually stunning sequence. Use slow reveals, wide establishing shots, and intentional pacing. Think film trailer with emotional weight. Let moments breathe.",
  },
  {
    key: "energetic",
    label: "Energetic",
    brief: "High-energy, fast-paced edit. Quick cuts synced to rhythm, build momentum throughout. Use the most dynamic moments from each clip. Keep the viewer locked in.",
  },
  {
    key: "calm",
    label: "Calm/Peaceful",
    brief: "Gentle, flowing sequence. Longer shots, soft transitions, peaceful pacing. Prioritize beauty and tranquility. Let the viewer relax into the imagery.",
  },
  {
    key: "horror",
    label: "Horror",
    brief: "Create a tense, unsettling sequence. Use sudden cuts, lingering dark shots, and unexpected reveals. Pacing should alternate between slow dread and sharp jolts.",
  },
  {
    key: "horror_comedy",
    label: "Horror Comedy",
    brief: "Mix tension with absurdity. Build dread then undercut with timing. Use awkward pauses, quick reveals, and comic juxtaposition. Think Shaun of the Dead pacing.",
  },
  {
    key: "documentary",
    label: "Documentary",
    brief: "Thoughtful, measured pacing. Let shots breathe. Prioritize storytelling and visual variety over speed. Use a journalistic eye for compelling moments.",
  },
  {
    key: "retro",
    label: "Retro/Vintage",
    brief: "Nostalgic, retro-styled edit. Slightly slower pacing, warm tones, vintage transitions. Think 70s film or VHS aesthetic. Imperfection is charm.",
  },
  {
    key: "action",
    label: "Action Trailer",
    brief: "Fast-paced, high-energy sequence. Quick cuts, build momentum, peak at a climactic moment. Think movie trailer energy. Impact hits, dramatic pauses, then explosive finale.",
  },
  {
    key: "romantic",
    label: "Romantic",
    brief: "Soft, intimate sequence. Gentle pacing, warm moments, dreamy transitions. Focus on connection and beauty. Use golden hour and close-up moments.",
  },
  {
    key: "travel",
    label: "Travel Vlog",
    brief: "Exciting travel montage. Mix wide vistas with intimate details. Show the journey -- movement, discovery, variety. Upbeat pacing that makes viewers want to go there.",
  },
];

export default function MoodPresets({ onSelect }: MoodPresetsProps) {
  return (
    <div className="space-y-2">
      <span className="text-xs text-white/50">Mood Preset</span>
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((preset) => (
          <button
            key={preset.key}
            onClick={() => onSelect(preset.brief)}
            className="px-2.5 py-1 rounded-lg text-[11px] font-medium bg-dark-300 text-white/50 border border-white/10 hover:border-green-400/30 hover:text-green-400 hover:bg-green-500/5 transition-all"
          >
            {preset.label}
          </button>
        ))}
      </div>
    </div>
  );
}
