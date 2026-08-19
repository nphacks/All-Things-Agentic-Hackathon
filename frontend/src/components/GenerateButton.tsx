interface GenerateButtonProps {
  disabled: boolean;
  loading: boolean;
  onClick: () => void;
}

export default function GenerateButton({ disabled, loading, onClick }: GenerateButtonProps) {
  return (
    <button
      onClick={onClick}
      disabled={disabled || loading}
      className={`
        w-full py-3 rounded-xl font-semibold text-sm tracking-wide transition-all
        ${disabled || loading
          ? "bg-dark-300 text-white/30 cursor-not-allowed border border-white/5"
          : "bg-green-500/20 text-green-400 border border-green-500/40 hover:bg-green-500/30 hover:border-green-400/60 active:scale-[0.98]"
        }
      `}
    >
      {loading ? "Creating job..." : "Generate Proposals"}
    </button>
  );
}
