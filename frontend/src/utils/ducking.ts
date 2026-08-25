/**
 * Auto-ducking utility.
 *
 * Computes music volume keyframes that duck under speech chunks.
 * Mirrors the backend _build_volume_keyframes logic for consistency.
 */

export interface DuckingKeyframe {
  time: number;
  volume: number;
  transition: string;
  fade_duration: number;
}

export interface DuckingSpeechChunk {
  start_time: number;
  end_time: number;
}

/**
 * Compute volume keyframes for music that auto-ducks under speech.
 *
 * Creates a volume envelope:
 * - Fade in at start (0 -> normalVolume over fadeInDuration)
 * - Duck to duckedVolume during each speech chunk
 * - Restore to normalVolume between chunks
 * - Fade out at end (normalVolume -> 0 over fadeOutDuration)
 */
export function computeDuckingKeyframes(
  timelineDuration: number,
  speechChunks: DuckingSpeechChunk[],
  options?: {
    normalVolume?: number;
    duckedVolume?: number;
    fadeInDuration?: number;
    fadeOutDuration?: number;
    duckFade?: number;
  },
): DuckingKeyframe[] {
  const normalVolume = options?.normalVolume ?? 0.5;
  const duckedVolume = options?.duckedVolume ?? 0.2;
  const fadeInDuration = options?.fadeInDuration ?? 1.0;
  const fadeOutDuration = options?.fadeOutDuration ?? 2.0;
  const duckFade = options?.duckFade ?? 0.4;

  const keyframes: DuckingKeyframe[] = [];

  // Fade in
  keyframes.push({ time: 0.0, volume: 0.0, transition: "fade", fade_duration: fadeInDuration });
  keyframes.push({ time: fadeInDuration, volume: normalVolume, transition: "fade", fade_duration: 0.0 });

  // Duck under speech chunks
  if (speechChunks.length > 0) {
    const sorted = [...speechChunks].sort((a, b) => a.start_time - b.start_time);

    for (const chunk of sorted) {
      const chunkStart = chunk.start_time;
      const chunkEnd = chunk.end_time || chunkStart + 3.0;

      // Don't duck if chunk is in the fade-in region
      if (chunkStart < fadeInDuration + 0.5) {
        keyframes.push({
          time: Math.max(chunkStart, fadeInDuration),
          volume: duckedVolume,
          transition: "fade",
          fade_duration: duckFade,
        });
      } else {
        // Set normal volume just before ducking
        keyframes.push({
          time: chunkStart - duckFade,
          volume: normalVolume,
          transition: "fade",
          fade_duration: 0.0,
        });
        keyframes.push({
          time: chunkStart,
          volume: duckedVolume,
          transition: "fade",
          fade_duration: duckFade,
        });
      }

      // Restore after speech ends (if not in fade-out region)
      if (chunkEnd < timelineDuration - fadeOutDuration - 0.5) {
        keyframes.push({
          time: chunkEnd,
          volume: duckedVolume,
          transition: "fade",
          fade_duration: 0.0,
        });
        keyframes.push({
          time: chunkEnd + duckFade,
          volume: normalVolume,
          transition: "fade",
          fade_duration: duckFade,
        });
      }
    }
  }

  // Fade out
  const fadeOutStart = Math.max(timelineDuration - fadeOutDuration, fadeInDuration + 1.0);
  keyframes.push({ time: fadeOutStart, volume: normalVolume, transition: "fade", fade_duration: 0.0 });
  keyframes.push({ time: timelineDuration, volume: 0.0, transition: "fade", fade_duration: fadeOutDuration });

  // Deduplicate by time (keep first seen) and sort
  const seen = new Set<number>();
  const unique: DuckingKeyframe[] = [];
  for (const kf of keyframes.sort((a, b) => a.time - b.time)) {
    const t = Math.round(kf.time * 100) / 100;
    if (!seen.has(t)) {
      seen.add(t);
      unique.push({ ...kf, time: t });
    }
  }

  return unique;
}
