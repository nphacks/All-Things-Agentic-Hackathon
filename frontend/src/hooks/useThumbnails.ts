import { useEffect, useState } from "react";

/**
 * Captures a frame from each video URL at the specified time.
 * Returns a map of URL -> data URL thumbnail.
 */
export function useThumbnails(
  clipUrls: string[],
  seekTimes?: Record<string, number>
): Record<string, string> {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});

  useEffect(() => {
    if (clipUrls.length === 0) return;

    let active = true;
    const results: Record<string, string> = {};

    async function captureAll() {
      const promises = clipUrls.map((url) => {
        return new Promise<void>((resolve) => {
          const video = document.createElement("video");
          video.crossOrigin = "anonymous";
          video.src = url;
          video.muted = true;
          video.playsInline = true;
          video.preload = "auto";

          const seekTime = seekTimes?.[url] ?? 0.5;

          video.addEventListener("loadeddata", () => {
            video.currentTime = seekTime;
          });

          video.addEventListener("seeked", () => {
            try {
              const canvas = document.createElement("canvas");
              canvas.width = video.videoWidth || 320;
              canvas.height = video.videoHeight || 180;
              const ctx = canvas.getContext("2d");
              if (ctx) {
                ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
                results[url] = canvas.toDataURL("image/jpeg", 0.6);
              }
            } catch {
              // CORS or other error -- leave empty
            }
            video.src = "";
            resolve();
          });

          video.addEventListener("error", () => {
            resolve();
          });

          // Timeout fallback
          setTimeout(() => resolve(), 5000);
        });
      });

      await Promise.all(promises);
      if (active) {
        setThumbnails(results);
      }
    }

    captureAll();

    return () => {
      active = false;
    };
  }, [clipUrls.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps

  return thumbnails;
}
