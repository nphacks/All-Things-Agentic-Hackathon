import { useEffect } from "react";
import type { JobSettings, JobStatus } from "../types";
import { useJobPolling } from "../hooks/useJobPolling";
import Loader from "./Loader";

interface ProcessingViewProps {
  jobId: string;
  clipFilenames: string[];
  settings?: JobSettings;
  onComplete: (job: JobStatus) => void;
  onRetry: () => void;
}

type StepStatus = "pending" | "active" | "completed";

function CheckCircle() {
  return (
    <svg className="w-5 h-5 text-green-400" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SmallCheck() {
  return (
    <svg className="w-4 h-4 text-green-400" viewBox="0 0 20 20" fill="currentColor">
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function StepDot({ status }: { status: StepStatus }) {
  if (status === "completed") {
    return <CheckCircle />;
  }
  if (status === "active") {
    return (
      <div className="relative">
        <div className="w-5 h-5 rounded-full border-2 border-green-400 bg-green-400/20" />
        <div className="absolute inset-0 w-5 h-5 rounded-full border-2 border-green-400 animate-ping opacity-30" />
      </div>
    );
  }
  return <div className="w-5 h-5 rounded-full border-2 border-white/20 bg-dark-400" />;
}

export default function ProcessingView({
  jobId,
  clipFilenames,
  settings,
  onComplete,
  onRetry,
}: ProcessingViewProps) {
  const { job, error } = useJobPolling(jobId);

  useEffect(() => {
    if (job && job.status === "completed") {
      const timeout = setTimeout(() => onComplete(job), 1000);
      return () => clearTimeout(timeout);
    }
  }, [job, onComplete]);

  const status = job?.status || "pending";
  const progress = job?.progress || "";
  const analyzedCount = job?.clip_analyses ? Object.keys(job.clip_analyses).length : 0;
  const voiceoverEnabled = settings?.add_voiceover ?? false;
  const textOverlaysEnabled = (settings?.add_captions ?? false) || (settings?.add_titles ?? false);

  // Parse progress for audio analysis count
  const audioMatch = progress.match(/(\d+) of \d+ \(audio\)/);
  const audioAnalyzedCount = audioMatch ? parseInt(audioMatch[1], 10) : 0;

  // Parse progress for text-overlay states
  const isTextOverlaysGenerating = progress.includes("text overlays");
  const textOverlayMatch = progress.match(/text overlays (\d+) of (\d+)/);

  // Parse progress for speech-related states.
  // Text overlays run AFTER speech, so once overlays start, speech is done.
  const isSpeechGenerating =
    (progress.includes("speech script") || progress.includes("Rendering speech")) &&
    !isTextOverlaysGenerating;
  const isRenderingSpeech = progress.includes("Rendering speech");

  // Determine step statuses
  const getStepStatus = (step: number): StepStatus => {
    if (status === "failed") {
      if (step === 1) return "completed";
      if (step === 2 && analyzedCount > 0) return "active";
      return "pending";
    }

    switch (step) {
      case 1: // Upload
        return "completed"; // always done by this point
      case 2: // Analyzing (video + audio)
        if (status === "analyzing") return "active";
        if (status === "generating" || status === "completed") return "completed";
        return "pending";
      case 3: // Generating proposals
        if (status === "generating" && !isSpeechGenerating && !isTextOverlaysGenerating) return "active";
        if (status === "generating" && (isSpeechGenerating || isTextOverlaysGenerating)) return "completed";
        if (status === "completed") return "completed";
        return "pending";
      case 4: // Speech (only relevant when voiceover enabled)
        if (status === "generating" && isSpeechGenerating) return "active";
        if (status === "generating" && isTextOverlaysGenerating) return "completed";
        if (status === "completed") return voiceoverEnabled ? "completed" : "pending";
        return "pending";
      case 5: // Text overlays (only relevant when captions/titles enabled)
        if (status === "generating" && isTextOverlaysGenerating) return "active";
        if (status === "completed") return textOverlaysEnabled ? "completed" : "pending";
        return "pending";
      case 6: // Complete
        if (status === "completed") return "completed";
        return "pending";
      default:
        return "pending";
    }
  };

  const step1 = getStepStatus(1);
  const step2 = getStepStatus(2);
  const step3 = getStepStatus(3);
  const step4 = getStepStatus(4);
  const step5 = getStepStatus(5);
  const step6 = getStepStatus(6);

  return (
    <div className="flex-1 flex items-center justify-center p-8">
      <div className="glass rounded-2xl p-8 max-w-md w-full space-y-6">
        {/* Loader at top */}
        {status !== "completed" && status !== "failed" && (
          <Loader size="sm" />
        )}

        {/* Vertical timeline */}
        <div className="relative pl-0 space-y-4">
          {/* Step 1: Upload */}
          <div className="flex items-center gap-3">
            <StepDot status={step1} />
            <span className={`text-base ${step1 === "completed" ? "text-white/90" : "text-white/40"}`}>
              Clips Uploaded
            </span>
          </div>

          {/* Step 2: Analyzing */}
          <div className="flex items-center gap-3">
            <StepDot status={step2} />
            <span className={`text-base ${step2 !== "pending" ? "text-white/90" : "text-white/40"}`}>
              Analyzing Clips
              {step2 === "active" && (
                <span className="text-sm text-green-400/70 ml-2">
                  {analyzedCount}/{clipFilenames.length}
                  {audioAnalyzedCount > 0 && (
                    <span className="text-white/40 ml-1">
                      (audio {audioAnalyzedCount}/{clipFilenames.length})
                    </span>
                  )}
                </span>
              )}
            </span>
          </div>

          {/* Clip sub-items */}
          {(step2 === "active" || step2 === "completed") && (
            <div className="ml-9 my-3 space-y-2">
              {clipFilenames.map((filename, i) => {
                const isAnalyzed = i < analyzedCount;
                return (
                  <div key={filename} className="flex items-center gap-2">
                    {isAnalyzed ? (
                      <SmallCheck />
                    ) : (
                      <div className="w-4 h-4 rounded-full border border-white/15 bg-dark-400" />
                    )}
                    <span className={`text-sm ${isAnalyzed ? "text-white/70" : "text-white/30"}`}>
                      {filename}
                    </span>
                  </div>
                );
              })}
              {analyzedCount >= clipFilenames.length && step3 === "pending" && (
                <div className="flex items-center gap-2 mt-2">
                  <div className="w-4 h-4 rounded-full border border-green-400/50 bg-green-400/10 animate-pulse" />
                  <span className="text-sm text-green-400/60 italic">Agent reviewing footage...</span>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Generating */}
          <div className="flex items-center gap-3">
            <StepDot status={step3} />
            <span className={`text-base ${step3 !== "pending" ? "text-white/90" : "text-white/40"}`}>
              Generating Proposals
              {step3 === "active" && job?.progress && job.progress.includes("Generated") && (
                <span className="text-sm text-green-400/70 ml-2">
                  {job.progress.replace("Generated ", "")}
                </span>
              )}
            </span>
          </div>

          {/* Step 4: Speech (only when voiceover enabled) */}
          {voiceoverEnabled && (
            <>
              <div className="flex items-center gap-3">
                <StepDot status={step4} />
                <span className={`text-base ${step4 !== "pending" ? "text-white/90" : "text-white/40"}`}>
                  Generating Speech
                  {step4 === "active" && (
                    <span className="text-sm text-green-400/70 ml-2">
                      {isRenderingSpeech ? "rendering audio..." : "writing script..."}
                    </span>
                  )}
                </span>
              </div>

              {/* Line between 4 and next */}
              <div className={`w-[2px] h-6 ml-[9px] ${step4 === "completed" ? "bg-green-400" : "bg-white/10"}`} />
            </>
          )}

          {/* Step 5: Text overlays (only when captions/titles enabled) */}
          {textOverlaysEnabled && (
            <>
              <div className="flex items-center gap-3">
                <StepDot status={step5} />
                <span className={`text-base ${step5 !== "pending" ? "text-white/90" : "text-white/40"}`}>
                  Adding Text &amp; Captions
                  {step5 === "active" && (
                    <span className="text-sm text-green-400/70 ml-2">
                      {textOverlayMatch
                        ? `${textOverlayMatch[1]}/${textOverlayMatch[2]}`
                        : "writing overlays..."}
                    </span>
                  )}
                </span>
              </div>

              {/* Line between 5 and complete */}
              <div className={`w-[2px] h-6 ml-[9px] ${step5 === "completed" ? "bg-green-400" : "bg-white/10"}`} />
            </>
          )}

          {/* Step 6: Complete */}
          <div className="flex items-center gap-3">
            <StepDot status={step6} />
            <span className={`text-base ${step6 === "completed" ? "text-green-400 font-medium" : "text-white/40"}`}>
              Complete
            </span>
          </div>
        </div>

        {/* Error state */}
        {(status === "failed" || error) && (
          <div className="space-y-3 text-center pt-2">
            <p className="text-sm text-red-400">
              {job?.error || error || "Something went wrong"}
            </p>
            <button
              onClick={onRetry}
              className="px-5 py-2 rounded-lg bg-dark-300 text-white/70 border border-white/10 hover:border-white/20 text-sm"
            >
              Try Again
            </button>
          </div>
        )}

        {/* Completed state */}
        {status === "completed" && (
          <p className="text-center text-sm text-green-400/80">
            Loading editor...
          </p>
        )}
      </div>
    </div>
  );
}
