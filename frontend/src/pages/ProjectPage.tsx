import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import type { ClipMetadata, JobSettings, JobStatus } from "../types";
import {
  createJob,
  getJob,
  getProject,
  updateProject,
} from "../services/api";
import UploadZone from "../components/UploadZone";
import BriefInput from "../components/BriefInput";
import MoodPresets from "../components/MoodPresets";
import SettingsPanel from "../components/SettingsPanel";
import GenerateButton from "../components/GenerateButton";
import ProcessingView from "../components/ProcessingView";
import EditorView from "../components/EditorView";
import Navbar from "../components/Navbar";
import SettingsDrawer from "../components/SettingsDrawer";
import Loader from "../components/Loader";

type PageView = "loading" | "input" | "processing" | "results";

function GearIcon({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-8 h-8 rounded-lg flex items-center justify-center text-white/40 hover:text-green-400 transition-colors"
      aria-label="Open settings"
    >
      <svg className="w-4.5 h-4.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.066 2.573c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.573 1.066c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.066-2.573c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" />
        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
      </svg>
    </button>
  );
}

export default function ProjectPage() {
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();

  const [view, setView] = useState<PageView>("loading");
  const [clips, setClips] = useState<ClipMetadata[]>([]);
  const [brief, setBrief] = useState("");
  const [settings, setSettings] = useState<JobSettings>({
    min_duration: 20,
    max_duration: 30,
    num_proposals: 3,
    variations: [],
    add_transitions: true,
    allow_filters: true,
    auto_brightness: true,
    manage_audio: true,
    add_voiceover: false,
    voice_name: "en-US-Journey-D",
    speaking_rate: 1.0,
    speech_context: "",
    add_background_music: true,
    add_captions: false,
    add_titles: true,
  });
  const [projectName, setProjectName] = useState("Untitled Project");
  const [jobId, setJobId] = useState<string | null>(null);
  const [jobResult, setJobResult] = useState<JobStatus | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);

  const canGenerate = clips.length >= 2 && brief.trim().length > 0;

  // Load project on mount
  useEffect(() => {
    if (!projectId) {
      navigate("/");
      return;
    }
    loadProject(projectId);
  }, [projectId]);

  async function loadProject(id: string) {
    try {
      const proj = await getProject(id);
      setProjectName(proj.name);

      // Convert project clips to ClipMetadata format
      if (proj.clips.length > 0) {
        const clipMetas: ClipMetadata[] = proj.clips.map((c) => ({
          clip_id: c.clip_id,
          filename: c.filename,
          file_path: `gcs://${id}/${c.clip_id}_${c.filename}`,
          size_bytes: 0,
          gcs_url: c.gcs_url,
          source: c.source === "generated" ? "generated" : "upload",
        }));
        setClips(clipMetas);
      }

      // If project has jobs with completed proposals, load the latest one
      if (proj.jobs.length > 0) {
        const latestJobId = proj.jobs[proj.jobs.length - 1];
        try {
          const job = await getJob(latestJobId);
          if (job.status === "completed" && job.proposals.length > 0) {
            setJobResult(job);
            setJobId(latestJobId);
            if (job.brief) setBrief(job.brief);
            setView("results");
            return;
          } else if (job.status === "analyzing" || job.status === "generating" || job.status === "pending") {
            setJobId(latestJobId);
            if (job.brief) setBrief(job.brief);
            setView("processing");
            return;
          }
        } catch {
          // Job not found, continue to input view
        }
      }

      setView("input");
    } catch {
      // Project not found
      navigate("/");
    }
  }

  // Save project name on change
  const handleProjectNameChange = async (name: string) => {
    setProjectName(name);
    if (projectId && name.trim()) {
      try {
        await updateProject(projectId, { name });
      } catch {
        // Non-critical, ignore
      }
    }
  };

  const handleClipsUploaded = (newClips: ClipMetadata[]) => {
    setClips((prev) => [...prev, ...newClips]);
  };

  const handleRemoveClip = (clipId: string) => {
    setClips((prev) => prev.filter((c) => c.clip_id !== clipId));
  };

  const handleGenerate = async () => {
    if (!canGenerate || !projectId) return;

    setIsCreating(true);
    setError(null);

    try {
      const clipIds = clips.map((c) => c.clip_id);
      const result = await createJob(brief, clipIds, settings, projectId);
      setJobId(result.job_id);
      setView("processing");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : "Failed to create job";
      setError(msg);
    } finally {
      setIsCreating(false);
    }
  };

  const handleJobComplete = useCallback((job: JobStatus) => {
    setJobResult(job);
    setView("results");
  }, []);

  const handleRetry = () => {
    setJobId(null);
    setJobResult(null);
    setView("input");
  };

  // Loading state
  if (view === "loading") {
    return (
      <div className="min-h-screen flex flex-col pt-20">
        <Navbar projectName={projectName} onProjectNameChange={handleProjectNameChange} />
        <div className="flex-1 flex items-center justify-center">
          <Loader size="md" />
        </div>
      </div>
    );
  }

  // Processing view
  if (view === "processing" && jobId) {
    return (
      <div className="min-h-screen flex flex-col pt-20">
        <Navbar
          projectName={projectName}
          onProjectNameChange={handleProjectNameChange}
          rightContent={<GearIcon onClick={() => setDrawerOpen(true)} />}
        />
        <SettingsDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          brief={brief}
          onBriefChange={setBrief}
          settings={settings}
          onSettingsChange={setSettings}
        />
        <ProcessingView
          jobId={jobId}
          clipFilenames={clips.map((c) => c.filename)}
          settings={settings}
          onComplete={handleJobComplete}
          onRetry={handleRetry}
        />
      </div>
    );
  }

  // Results view -- full editor
  if (view === "results" && jobResult) {
    return (
      <div className="min-h-screen flex flex-col pt-20">
        <Navbar
          projectName={projectName}
          onProjectNameChange={handleProjectNameChange}
          rightContent={<GearIcon onClick={() => setDrawerOpen(true)} />}
        />
        <SettingsDrawer
          isOpen={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          brief={brief}
          onBriefChange={setBrief}
          settings={settings}
          onSettingsChange={setSettings}
        />
        <EditorView job={jobResult} onNewEdit={handleRetry} projectId={projectId} />
      </div>
    );
  }

  // Input view
  return (
    <div className="min-h-screen flex flex-col pt-20">
      <Navbar
        projectName={projectName}
        onProjectNameChange={handleProjectNameChange}
        rightContent={<GearIcon onClick={() => setDrawerOpen(true)} />}
      />
      <SettingsDrawer
        isOpen={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        brief={brief}
        onBriefChange={setBrief}
        settings={settings}
        onSettingsChange={setSettings}
      />

      {/* Main content -- two column layout */}
      <main className="flex-1 flex items-start justify-center px-8 py-6">
        <div className="w-full max-w-6xl flex gap-6 min-h-[calc(100vh-8rem)]">
          {/* Left: Upload / Media Bin */}
          <div className="w-2/5 flex flex-col">
            <h3 className="text-xs uppercase tracking-widest text-white/40 mb-3">Media Bin</h3>
            <div className="flex-1 flex flex-col">
              <UploadZone
                clips={clips}
                onClipsUploaded={handleClipsUploaded}
                onRemoveClip={handleRemoveClip}
                projectId={projectId}
              />
            </div>
          </div>

          {/* Right: Brief + Settings + Generate */}
          <div className="w-3/5 flex flex-col gap-5">
            <h3 className="text-xs uppercase tracking-widest text-white/40 mb-1">Configure</h3>

            {/* Mood presets -- fill the brief with a starting template */}
            <MoodPresets onSelect={setBrief} />

            {/* Brief */}
            <BriefInput value={brief} onChange={setBrief} />

            {/* Settings */}
            <SettingsPanel settings={settings} onChange={setSettings} />

            {/* Error */}
            {error && (
              <p className="text-red-400 text-sm text-center">{error}</p>
            )}

            {/* Generate */}
            <GenerateButton
              disabled={!canGenerate}
              loading={isCreating}
              onClick={handleGenerate}
            />

            {/* Validation hint */}
            {!canGenerate && (
              <p className="text-xs text-white/30 text-center">
                {clips.length < 2 && brief.trim().length === 0
                  ? "Upload at least 2 clips and add a brief to continue"
                  : clips.length < 2
                  ? "Upload at least 2 clips to continue"
                  : "Add a brief to continue"}
              </p>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
