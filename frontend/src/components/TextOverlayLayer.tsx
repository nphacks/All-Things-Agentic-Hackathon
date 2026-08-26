import type { CSSProperties } from "react";
import type { TextOverlay } from "../types";

interface TextOverlayLayerProps {
  overlays: TextOverlay[];
  /** Current playback position in TIMELINE seconds */
  currentTime: number;
}

const FADE_DURATION = 0.4; // seconds for fade/slide in-out

/** Vertical anchoring per overlay position */
function positionStyle(position: TextOverlay["position"]): CSSProperties {
  switch (position) {
    case "center":
      return { top: "50%", transform: "translateY(-50%)" };
    case "upper":
      return { top: "12%" };
    case "lower":
    default:
      return { bottom: "10%" };
  }
}

/** Font size mapping (responsive to container via clamp) */
function fontSizeValue(size: TextOverlay["style"]["font_size"]): string {
  switch (size) {
    case "large":
      return "clamp(1.25rem, 4.5vw, 2.75rem)";
    case "small":
      return "clamp(0.7rem, 1.8vw, 1rem)";
    case "medium":
    default:
      return "clamp(0.9rem, 2.6vw, 1.5rem)";
  }
}

/** Background box style */
function backgroundStyle(bg: TextOverlay["style"]["background"]): CSSProperties {
  switch (bg) {
    case "solid":
      return { backgroundColor: "rgba(0,0,0,0.85)", padding: "0.4em 0.8em", borderRadius: "0.35rem" };
    case "semi":
      return { backgroundColor: "rgba(0,0,0,0.5)", padding: "0.35em 0.7em", borderRadius: "0.35rem" };
    case "none":
    default:
      return { textShadow: "0 2px 8px rgba(0,0,0,0.85), 0 0 2px rgba(0,0,0,0.9)" };
  }
}

/**
 * Compute the animation-driven opacity + transform for an overlay at the given time.
 * Returns null when the overlay is not visible at this time.
 */
function computeVisual(
  overlay: TextOverlay,
  time: number,
): { opacity: number; translateX: number } | null {
  const { start_time, end_time, animation } = overlay;
  if (time < start_time || time > end_time) return null;

  const sinceStart = time - start_time;
  const untilEnd = end_time - time;

  let opacity = 1;
  let translateX = 0;

  if (animation === "fade") {
    const fadeIn = Math.min(1, sinceStart / FADE_DURATION);
    const fadeOut = Math.min(1, untilEnd / FADE_DURATION);
    opacity = Math.max(0, Math.min(fadeIn, fadeOut));
  } else if (animation === "slide") {
    const slideIn = Math.min(1, sinceStart / FADE_DURATION);
    const fadeOut = Math.min(1, untilEnd / FADE_DURATION);
    opacity = Math.max(0, Math.min(slideIn, fadeOut));
    // Slide in from the left; settle at 0
    translateX = (1 - slideIn) * -24;
  }

  return { opacity, translateX };
}

/**
 * Renders text overlays (titles, lower thirds, captions, end cards) as absolutely
 * positioned divs over the video, timed to the timeline and animated (fade/slide).
 */
export default function TextOverlayLayer({ overlays, currentTime }: TextOverlayLayerProps) {
  if (!overlays || overlays.length === 0) return null;

  return (
    <div className="absolute inset-0 pointer-events-none z-[18] overflow-hidden">
      {overlays.map((overlay) => {
        const visual = computeVisual(overlay, currentTime);
        if (!visual) return null;

        const pos = positionStyle(overlay.position);
        const baseTransform = pos.transform ? String(pos.transform) : "";
        const slideTransform = visual.translateX !== 0 ? `translateX(${visual.translateX}px)` : "";
        const transform = [baseTransform, slideTransform].filter(Boolean).join(" ");

        return (
          <div
            key={overlay.id}
            className="absolute left-0 right-0 flex justify-center px-[6%]"
            style={{ ...pos, transform: transform || undefined, opacity: visual.opacity }}
          >
            <span
              className="inline-block text-center font-semibold leading-tight max-w-[90%]"
              style={{
                color: overlay.style.color || "#ffffff",
                fontSize: fontSizeValue(overlay.style.font_size),
                ...backgroundStyle(overlay.style.background),
              }}
            >
              {overlay.text}
            </span>
          </div>
        );
      })}
    </div>
  );
}
