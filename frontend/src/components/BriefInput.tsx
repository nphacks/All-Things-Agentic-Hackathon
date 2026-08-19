interface BriefInputProps {
  value: string;
  onChange: (value: string) => void;
}

export default function BriefInput({ value, onChange }: BriefInputProps) {
  return (
    <div className="space-y-2">
      <label htmlFor="brief" className="text-sm font-medium text-white/70">
        Creative Brief
      </label>
      <textarea
        id="brief"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Describe what you want to make... (e.g., '30-second energetic travel ad showcasing beaches, culture, and nightlife')"
        rows={3}
        className="w-full rounded-xl glass px-4 py-3 text-sm text-white placeholder-white/30 focus:outline-none focus:border-green-400/50 resize-none"
      />
    </div>
  );
}
