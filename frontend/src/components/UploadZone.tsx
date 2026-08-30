import { useCallback, useEffect, useRef, useState } from "react";
import type { ClipMetadata } from "../types";
import { uploadClips, getClipLibrary, addClipFromLibrary } from "../services/api";
import type { LibraryClip } from "../services/api";
import Loader from "./Loader";

interface UploadZoneProps {
  clips: ClipMetadata[];
  onClipsUploaded: (newClips: ClipMetadata[]) => void;
  onRemoveClip?: (clipId: string) => void;
  projectId?: string;
}

/** Capture first frame from a video File and return as data URL */
function captureFrame(file: File): Promise<string> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const video = document.createElement("video");
    video.src = url;
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";

    video.addEventListener("loadeddata", () => {
      // Seek to 0.5s for a more representative frame
      video.currentTime = 0.5;
    });

    video.addEventListener("seeked", () => {
      const canvas = document.createElement("canvas");
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.drawImage(video, 0, 0);
        const dataUrl = canvas.toDataURL("image/jpeg", 0.7);
        resolve(dataUrl);
      } else {
        resolve("");
      }
      URL.revokeObjectURL(url);
    });

    // Fallback if seek fails
    video.addEventListener("error", () => {
      URL.revokeObjectURL(url);
      resolve("");
    });
  });
}

export default function UploadZone({ clips, onClipsUploaded, onRemoveClip, projectId }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const [activeTab, setActiveTab] = useState<"upload" | "library">("upload");
  const [library, setLibrary] = useState<LibraryClip[]>([]);
  const [libraryLoading, setLibraryLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // Fetch library when tab is opened
  useEffect(() => {
    if (activeTab === "library" && library.length === 0) {
      setLibraryLoading(true);
      getClipLibrary()
        .then(setLibrary)
        .catch(() => setLibrary([]))
        .finally(() => setLibraryLoading(false));
    }
  }, [activeTab, library.length]);

  // IDs of clips already in this project
  const currentClipUrls = new Set(clips.map((c) => c.gcs_url).filter(Boolean));

  function handleAddFromLibrary(libClip: LibraryClip) {
    if (currentClipUrls.has(libClip.gcs_url)) return;
    // Register in backend
    if (projectId) {
      addClipFromLibrary(projectId, {
        clip_id: libClip.clip_id,
        filename: libClip.filename,
        gcs_url: libClip.gcs_url,
      }).catch(() => {});
    }
    // Optimistic UI update
    const newClip: ClipMetadata = {
      clip_id: libClip.clip_id,
      filename: libClip.filename,
      file_path: "",
      size_bytes: 0,
      gcs_url: libClip.gcs_url,
    };
    onClipsUploaded([newClip]);
  }

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files).filter((f) =>
        ["video/mp4", "video/quicktime", "video/webm"].includes(f.type) ||
        f.name.endsWith(".mp4") || f.name.endsWith(".mov") || f.name.endsWith(".webm")
      );

      if (fileArray.length === 0) {
        setError("No valid video files selected. Accepted: mp4, mov, webm.");
        return;
      }

      // Reject any single clip over 100MB before uploading
      const MAX_FILE_SIZE_MB = 100;
      const tooLarge = fileArray.filter((f) => f.size > MAX_FILE_SIZE_MB * 1024 * 1024);
      if (tooLarge.length > 0) {
        const names = tooLarge.map((f) => `${f.name} (${(f.size / 1024 / 1024).toFixed(0)}MB)`).join(", ");
        setError(`These clips exceed the ${MAX_FILE_SIZE_MB}MB limit: ${names}. Please use smaller clips.`);
        return;
      }

      setError(null);
      setIsUploading(true);

      // Capture thumbnails in parallel while uploading
      const framePromises = fileArray.map((f) => captureFrame(f));

      try {
        const [result, frames] = await Promise.all([
          uploadClips(fileArray, undefined, projectId),
          Promise.all(framePromises),
        ]);

        // Map thumbnails by clip_id
        const newThumbs: Record<string, string> = {};
        result.forEach((clip, i) => {
          if (frames[i]) newThumbs[clip.clip_id] = frames[i];
        });
        setThumbnails((prev) => ({ ...prev, ...newThumbs }));

        onClipsUploaded(result);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : "Upload failed";
        setError(msg);
      } finally {
        setIsUploading(false);
      }
    },
    [onClipsUploaded, projectId]
  );

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [handleFiles]
  );

  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  };

  const onDragLeave = () => setIsDragging(false);

  const onFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files);
      e.target.value = "";
    }
  };

  const removeClip = (clipId: string) => {
    if (onRemoveClip) onRemoveClip(clipId);
  };

  return (
    <div className="space-y-3">
      {/* Tab toggle */}
      <div className="flex gap-1 p-0.5 rounded-lg bg-dark-400/50">
        <button
          onClick={() => setActiveTab("upload")}
          className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "upload"
              ? "bg-dark-300 text-white/90"
              : "text-white/40 hover:text-white/60"
          }`}
        >
          Upload
        </button>
        <button
          onClick={() => setActiveTab("library")}
          className={`flex-1 px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
            activeTab === "library"
              ? "bg-dark-300 text-white/90"
              : "text-white/40 hover:text-white/60"
          }`}
        >
          Library
        </button>
      </div>

      {/* Upload tab */}
      {activeTab === "upload" && (
        <>
          {/* Drop zone */}
          <div
            onDrop={onDrop}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onClick={() => inputRef.current?.click()}
            className={`
              glass rounded-xl p-6 text-center cursor-pointer transition-all min-h-[160px] flex items-center justify-center
              ${isDragging ? "border-green-400 bg-green-500/10" : "hover:border-white/15"}
            `}
          >
            <input
              ref={inputRef}
              type="file"
              accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm"
              multiple
              onChange={onFileSelect}
              className="hidden"
            />

            {isUploading ? (
              <div className="py-2">
                <Loader size="sm" />
              </div>
            ) : (
              <div className="space-y-2">
                <div className="text-4xl opacity-40">+</div>
                <p className="text-sm text-white/70">
                  Drop video clips here or click to browse
                </p>
                <p className="text-xs text-white/40">
                  MP4, MOV, or WebM -- max 200MB each, up to 10 clips
                </p>
              </div>
            )}
          </div>

          {/* Error */}
          {error && (
            <p className="text-red-400 text-sm px-1">{error}</p>
          )}
        </>
      )}

      {/* Library tab */}
      {activeTab === "library" && (
        <div className="glass rounded-xl p-4 min-h-[160px]">
          {libraryLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader size="sm" />
            </div>
          ) : library.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm text-white/40">No clips in library yet</p>
              <p className="text-xs text-white/25 mt-1">Upload clips to any project to build your library</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-2">
              {library.map((libClip) => {
                const alreadyAdded = currentClipUrls.has(libClip.gcs_url);
                return (
                  <button
                    key={libClip.clip_id}
                    onClick={() => handleAddFromLibrary(libClip)}
                    disabled={alreadyAdded}
                    className={`rounded-lg p-2 text-left transition-all ${
                      alreadyAdded
                        ? "bg-dark-400/30 opacity-50 cursor-default"
                        : "bg-dark-400/50 hover:bg-dark-300 hover:border-green-400/20 border border-transparent cursor-pointer"
                    }`}
                  >
                    {/* Video thumbnail */}
                    <div className="w-full h-14 rounded bg-dark-500 overflow-hidden mb-1.5">
                      <video
                        src={libClip.gcs_url}
                        muted
                        preload="metadata"
                        className="w-full h-full object-cover"
                        onLoadedMetadata={(e) => {
                          e.currentTarget.currentTime = 0.5;
                        }}
                      />
                    </div>
                    <p className="text-xs text-white/70 truncate">{libClip.filename}</p>
                    {alreadyAdded && (
                      <p className="text-[10px] text-green-400/60 mt-0.5">Added</p>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Uploaded clips as cards (always visible below) */}
      {clips.length > 0 && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          {clips.map((clip) => (
            <div
              key={clip.clip_id}
              className="glass-light rounded-lg p-2 relative group"
            >
              {/* Thumbnail */}
              <div className="w-full h-16 rounded bg-dark-400 overflow-hidden mb-1.5">
                {thumbnails[clip.clip_id] ? (
                  <img
                    src={thumbnails[clip.clip_id]}
                    alt={clip.filename}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <svg className="w-5 h-5 text-green-400/40" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                    </svg>
                  </div>
                )}
              </div>
              <p className="text-xs text-white/80 truncate">{clip.filename}</p>
              <p className="text-[10px] text-white/35">{(clip.size_bytes / 1024 / 1024).toFixed(1)}MB</p>
              {/* Remove button */}
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  removeClip(clip.clip_id);
                }}
                className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-dark-400/80 text-white/30 hover:text-red-400 hover:bg-dark-300 flex items-center justify-center text-xs opacity-0 group-hover:opacity-100 transition-opacity"
                aria-label={`Remove ${clip.filename}`}
              >
                x
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
