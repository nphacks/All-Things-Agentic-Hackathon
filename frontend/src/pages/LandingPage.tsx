import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createProject, listProjects } from "../services/api";
import type { ProjectListItem } from "../services/api";
import Navbar from "../components/Navbar";
import Loader from "../components/Loader";

export default function LandingPage() {
  const navigate = useNavigate();
  const [projects, setProjects] = useState<ProjectListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    loadProjects();
  }, []);

  async function loadProjects() {
    try {
      const list = await listProjects();
      setProjects(list);
    } catch {
      // If backend is down, show empty state
      setProjects([]);
    } finally {
      setLoading(false);
    }
  }

  async function handleNewProject() {
    setCreating(true);
    try {
      const project = await createProject("Untitled Project");
      navigate(`/project/${project.project_id}`);
    } catch {
      // Fallback: navigate without creating (will create on first action)
      setCreating(false);
    }
  }

  function formatDate(dateStr: string | null): string {
    if (!dateStr) return "";
    try {
      const date = new Date(dateStr);
      return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    } catch {
      return "";
    }
  }

  return (
    <div className="min-h-screen flex flex-col pt-20">
      <Navbar projectName="Cutting" onProjectNameChange={() => {}} />

      <main className="flex-1 px-8 py-8 max-w-5xl mx-auto w-full">
        {/* Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-semibold text-white">Projects</h1>
            <p className="text-sm text-white/40 mt-1">
              Create AI-powered video edits from raw clips
            </p>
          </div>
          <button
            onClick={handleNewProject}
            disabled={creating}
            className="px-5 py-2.5 rounded-xl bg-green-500/20 border border-green-400/30 text-green-400 font-medium text-sm hover:bg-green-500/30 hover:border-green-400/50 transition-all disabled:opacity-50"
          >
            {creating ? "Creating..." : "+ New Project"}
          </button>
        </div>

        {/* Loading */}
        {loading && (
          <div className="flex items-center justify-center py-20">
            <Loader size="md" />
          </div>
        )}

        {/* Empty state */}
        {!loading && projects.length === 0 && (
          <div className="flex flex-col items-center justify-center py-20 glass rounded-2xl">
            <div className="w-16 h-16 rounded-full bg-green-500/10 border border-green-400/20 flex items-center justify-center mb-4">
              <svg className="w-7 h-7 text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-white mb-1">No projects yet</h3>
            <p className="text-sm text-white/40 mb-6">
              Create your first project to start editing with AI
            </p>
            <button
              onClick={handleNewProject}
              disabled={creating}
              className="px-5 py-2.5 rounded-xl bg-green-500/20 border border-green-400/30 text-green-400 font-medium text-sm hover:bg-green-500/30 transition-all disabled:opacity-50"
            >
              {creating ? "Creating..." : "+ New Project"}
            </button>
          </div>
        )}

        {/* Project grid */}
        {!loading && projects.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {projects.map((project) => (
              <button
                key={project.project_id}
                onClick={() => navigate(`/project/${project.project_id}`)}
                className="text-left glass rounded-xl p-5 hover:border-green-400/30 hover:bg-white/[0.04] transition-all group"
              >
                {/* Thumbnail placeholder */}
                <div className="w-full aspect-video rounded-lg bg-dark-300 mb-3 flex items-center justify-center overflow-hidden">
                  <svg className="w-8 h-8 text-white/10 group-hover:text-green-400/20 transition-colors" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1} d="M15 10l4.553-2.276A1 1 0 0121 8.618v6.764a1 1 0 01-1.447.894L15 14M5 18h8a2 2 0 002-2V8a2 2 0 00-2-2H5a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </div>

                {/* Info */}
                <h3 className="text-sm font-medium text-white truncate">
                  {project.name}
                </h3>
                <div className="flex items-center gap-3 mt-1.5">
                  <span className="text-xs text-white/30">
                    {project.clip_count} clip{project.clip_count !== 1 ? "s" : ""}
                  </span>
                  <span className="text-xs text-white/30">
                    {project.job_count} edit{project.job_count !== 1 ? "s" : ""}
                  </span>
                  {project.updated_at && (
                    <span className="text-xs text-white/20 ml-auto">
                      {formatDate(project.updated_at)}
                    </span>
                  )}
                </div>
              </button>
            ))}
          </div>
        )}
      </main>
    </div>
  );
}
