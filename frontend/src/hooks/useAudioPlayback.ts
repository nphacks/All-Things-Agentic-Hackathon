/**
 * useAudioPlayback -- 3-layer audio mixing hook.
 *
 * Manages playback of:
 * - Original audio (via video element volume control)
 * - Speech chunks (individual Audio elements)
 * - Background music (single Audio element with volume keyframes)
 *
 * All layers sync to the master clock (video timeline time).
 */

import { useEffect, useRef, useCallback } from "react";
import type { AudioTrackState, SpeechChunk } from "../components/AudioTracks";
import type { MusicSelection } from "../components/MusicPanel";
import type { AudioKeyframe } from "../types";

interface UseAudioPlaybackOptions {
  /** Current timeline time in seconds (from video player) */
  currentTime: number;
  /** Whether the video is currently playing */
  isPlaying: boolean;
  /** Total timeline duration */
  totalDuration: number;
  /** Speech chunks to play */
  speechChunks: SpeechChunk[];
  /** Background music selection */
  music: MusicSelection | null;
  /** Original audio volume keyframes (per-segment) */
  originalKeyframes: AudioKeyframe[];
  /** Track mute/volume state */
  trackState: AudioTrackState;
  /** Callback to set video element volume (original audio layer) */
  onSetVideoVolume?: (volume: number) => void;
}

/** Interpolate volume between two keyframes at a given time */
function interpolateVolume(keyframes: { time: number; volume: number }[], time: number): number {
  if (!keyframes || keyframes.length === 0) return 1.0;

  // Before first keyframe
  if (time <= keyframes[0].time) return keyframes[0].volume;
  // After last keyframe
  if (time >= keyframes[keyframes.length - 1].time) return keyframes[keyframes.length - 1].volume;

  // Find surrounding keyframes
  for (let i = 0; i < keyframes.length - 1; i++) {
    const curr = keyframes[i];
    const next = keyframes[i + 1];
    if (time >= curr.time && time <= next.time) {
      const range = next.time - curr.time;
      if (range <= 0) return next.volume;
      const progress = (time - curr.time) / range;
      return curr.volume + (next.volume - curr.volume) * progress;
    }
  }

  return 1.0;
}

export default function useAudioPlayback({
  currentTime,
  isPlaying,
  totalDuration,
  speechChunks,
  music,
  originalKeyframes,
  trackState,
  onSetVideoVolume,
}: UseAudioPlaybackOptions) {
  // Speech audio elements (one per chunk)
  const speechAudiosRef = useRef<Map<string, HTMLAudioElement>>(new Map());
  // Music audio element
  const musicAudioRef = useRef<HTMLAudioElement | null>(null);
  // Track which speech chunks are currently playing
  const activeSpeechRef = useRef<Set<string>>(new Set());
  // Last known time for seek detection
  const lastTimeRef = useRef<number>(0);
  // RAF for volume updates
  const rafRef = useRef<number | null>(null);

  // --- Music element management ---
  useEffect(() => {
    const musicUrl = music?.preview_url || music?.url;
    if (!musicUrl) {
      // No music -- cleanup
      if (musicAudioRef.current) {
        musicAudioRef.current.pause();
        musicAudioRef.current.src = "";
        musicAudioRef.current = null;
      }
      return;
    }

    // Create or update music element
    if (!musicAudioRef.current) {
      musicAudioRef.current = new Audio();
      musicAudioRef.current.loop = false;
      musicAudioRef.current.preload = "auto";
    }

    if (musicAudioRef.current.src !== musicUrl) {
      musicAudioRef.current.src = musicUrl;
      musicAudioRef.current.load();
    }

    return () => {
      // Don't destroy on re-render, only on unmount
    };
  }, [music?.preview_url, music?.url]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      // Cleanup all audio elements
      for (const audio of speechAudiosRef.current.values()) {
        audio.pause();
        audio.src = "";
      }
      speechAudiosRef.current.clear();
      if (musicAudioRef.current) {
        musicAudioRef.current.pause();
        musicAudioRef.current.src = "";
        musicAudioRef.current = null;
      }
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
      }
    };
  }, []);

  // --- Speech element management ---
  useEffect(() => {
    const currentMap = speechAudiosRef.current;
    const chunkIds = new Set(speechChunks.map((c) => c.chunk_id));

    // Remove audio elements for deleted chunks
    for (const [id, audio] of currentMap.entries()) {
      if (!chunkIds.has(id)) {
        audio.pause();
        audio.src = "";
        currentMap.delete(id);
      }
    }

    // Create/update audio elements for current chunks
    for (const chunk of speechChunks) {
      if (!chunk.gcs_url) continue;
      let audio = currentMap.get(chunk.chunk_id);
      if (!audio) {
        audio = new Audio();
        audio.preload = "auto";
        currentMap.set(chunk.chunk_id, audio);
      }
      if (audio.src !== chunk.gcs_url) {
        audio.src = chunk.gcs_url;
        audio.load();
      }
    }
  }, [speechChunks]);

  // --- Play/Pause sync ---
  useEffect(() => {
    if (!isPlaying) {
      // Pause all audio
      for (const audio of speechAudiosRef.current.values()) {
        if (!audio.paused) audio.pause();
      }
      if (musicAudioRef.current && !musicAudioRef.current.paused) {
        musicAudioRef.current.pause();
      }
      activeSpeechRef.current.clear();

      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    }
  }, [isPlaying]);

  // --- Main sync logic (runs on every time update) ---
  const syncAudio = useCallback(() => {
    const time = currentTime;

    // Detect seek (jump > 0.5s)
    const isSeek = Math.abs(time - lastTimeRef.current) > 0.5;
    lastTimeRef.current = time;

    // --- Original audio volume ---
    if (onSetVideoVolume) {
      if (trackState.originalMuted) {
        onSetVideoVolume(0);
      } else {
        const baseVol = interpolateVolume(originalKeyframes, time);
        onSetVideoVolume(baseVol * trackState.originalVolume);
      }
    }

    // --- Speech layer ---
    for (const chunk of speechChunks) {
      if (!chunk.gcs_url) continue;
      const audio = speechAudiosRef.current.get(chunk.chunk_id);
      if (!audio) continue;

      const chunkEnd = chunk.end_time || (chunk.start_time + (chunk.audio_duration || 3));
      const shouldPlay = isPlaying && time >= chunk.start_time && time < chunkEnd;

      if (shouldPlay) {
        if (trackState.speechMuted) {
          audio.volume = 0;
        } else {
          audio.volume = trackState.speechVolume;
        }

        if (!activeSpeechRef.current.has(chunk.chunk_id) || isSeek) {
          // On a seek, jump into the chunk at the right offset.
          // On natural playback start, always begin from 0 so the first
          // words are not clipped (currentTime is throttled and may lag the
          // true chunk start by up to ~200ms).
          if (isSeek) {
            audio.currentTime = Math.max(0, time - chunk.start_time);
          } else {
            audio.currentTime = 0;
          }
          audio.play().catch(() => {});
          activeSpeechRef.current.add(chunk.chunk_id);
        }
      } else {
        if (activeSpeechRef.current.has(chunk.chunk_id)) {
          audio.pause();
          activeSpeechRef.current.delete(chunk.chunk_id);
        }
      }
    }

    // --- Music layer ---
    const musicAudio = musicAudioRef.current;
    if (musicAudio && music) {
      const placement = music.placement;
      const startTime = placement?.start_time ?? 0;
      const endTime = placement?.end_time ?? totalDuration;
      const trackStart = placement?.track_start ?? 0;

      const shouldPlayMusic = isPlaying && time >= startTime && time < endTime;

      if (shouldPlayMusic) {
        // Calculate volume from keyframes
        const musicKeyframes = music.volume_keyframes || [];
        let vol: number;
        if (trackState.musicMuted) {
          vol = 0;
        } else {
          const baseVol = interpolateVolume(musicKeyframes, time);
          vol = baseVol * trackState.musicVolume;
        }
        musicAudio.volume = Math.max(0, Math.min(1, vol));

        if (musicAudio.paused || isSeek) {
          // Seek to correct position in track
          const musicOffset = trackStart + (time - startTime);
          musicAudio.currentTime = musicOffset;
          musicAudio.play().catch(() => {});
        }
      } else {
        if (!musicAudio.paused) {
          musicAudio.pause();
        }
      }
    }
  }, [currentTime, isPlaying, speechChunks, music, totalDuration, originalKeyframes, trackState, onSetVideoVolume]);

  // Run sync on every time update when playing
  useEffect(() => {
    syncAudio();
  }, [syncAudio]);
}
