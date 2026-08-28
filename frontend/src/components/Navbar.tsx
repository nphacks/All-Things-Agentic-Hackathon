import { useState } from "react";
import { Link } from "react-router-dom";

interface NavbarProps {
  projectName?: string;
  onProjectNameChange?: (name: string) => void;
  rightContent?: React.ReactNode;
}

export default function Navbar({ projectName, onProjectNameChange, rightContent }: NavbarProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState(projectName || "");

  const handleSubmit = () => {
    const trimmed = editValue.trim();
    if (trimmed && onProjectNameChange) {
      onProjectNameChange(trimmed);
    } else {
      setEditValue(projectName || "");
    }
    setIsEditing(false);
  };

  return (
    <div className="fixed top-4 left-1/2 -translate-x-1/2 z-50 w-auto max-w-3xl">
      <nav className="glass-strong rounded-full px-6 py-3 flex items-center gap-4 min-w-[280px]">
        {/* Logo / App name -- links to landing page */}
        <Link
          to="/"
          className="flex items-center gap-2 hover:opacity-80 transition-opacity"
          title="Back to projects"
        >
          <img src="/logo.png" alt="Cutting" className="w-6 h-6 rounded" />
          <span className="text-green-400 font-semibold text-sm tracking-tight whitespace-nowrap">
            Cutting
          </span>
        </Link>

        {/* Divider + project name (only when a project is open) */}
        {projectName && (
          <>
            <div className="w-px h-5 bg-white/10" />

            {isEditing ? (
              <input
                type="text"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                onBlur={handleSubmit}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSubmit();
                  if (e.key === "Escape") {
                    setEditValue(projectName);
                    setIsEditing(false);
                  }
                }}
                autoFocus
                className="bg-transparent border-b border-green-400/50 text-sm text-white outline-none px-1 py-0 min-w-[120px]"
              />
            ) : (
              <button
                onClick={() => {
                  setEditValue(projectName);
                  setIsEditing(true);
                }}
                className="text-sm text-white/70 hover:text-white transition-colors truncate max-w-[200px]"
                title="Click to rename project"
              >
                {projectName}
              </button>
            )}
          </>
        )}

        {/* Spacer */}
        <div className="flex-1" />

        {/* Right content (settings icon, etc) */}
        {rightContent}

        {/* Version */}
        <span className="text-xs text-gold-400/60 whitespace-nowrap">v0.1</span>
      </nav>
    </div>
  );
}
