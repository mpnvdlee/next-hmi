import { create } from 'zustand';
import { projectSlug } from '@shared/utils/runtimeBase';
import { managerApiJson } from '@shared/utils/api';

/**
 * Why this project document cannot show its project, or `null` while it can.
 *
 * Mirrors `_unavailable_reason` in backend/manager.py — the manager serves this
 * document itself when the instance behind the URL is not there to serve it, so
 * the SPA boots with no backend of its own and has to say why.
 */
export type UnavailableReason = 'stopped' | 'crashed' | 'missing' | 'unknown';

interface ProjectAvailabilityStore {
  reason: UnavailableReason | null;
  /** The project's registered name, when the manager knows one. */
  projectName: string | null;
  resolve(): Promise<void>;
}

type ManagerProject = { id: string; name?: string; status?: string };
type ManagerInstance = { id: string; status?: string };

/** The same ladder `_unavailable_reason` walks, from what the manager reports. */
export function reasonFor(
  projectId: string,
  projects: ManagerProject[],
  instances: ManagerInstance[],
): UnavailableReason | null {
  const entry = projects.find((p) => p.id === projectId);
  if (!entry) return 'unknown';
  if (entry.status === 'missing') return 'missing';
  const status = instances.find((i) => i.id === projectId)?.status;
  // `starting` is on its way up, same as the backend's guard — the app's own
  // retries will reach it, so nothing is blocked over it.
  if (status === 'running' || status === 'starting') return null;
  return status === 'crashed' ? 'crashed' : 'stopped';
}

let inFlight: Promise<void> | null = null;

export const useProjectAvailabilityStore = create<ProjectAvailabilityStore>((set) => ({
  reason: null,
  projectName: null,
  /**
   * Confirm with the manager before blocking the document.
   *
   * A 503 alone isn't proof: the manager answers one for an instance that is
   * still coming up, and blocking on that would hide a project that is about to
   * appear. Coalesced, because every gated call fails at once.
   */
  resolve: () => {
    // A resolved reason is terminal — the overlay's only action navigates away,
    // and nothing clears it — so re-probing after it is set can only repeat the
    // same answer. Without this the instance's own polls keep 503-ing behind
    // the overlay and each wave starts another pair of manager round-trips.
    if (useProjectAvailabilityStore.getState().reason) return Promise.resolve();
    if (inFlight) return inFlight;
    const projectId = projectSlug();
    if (!projectId) return Promise.resolve();
    inFlight = (async () => {
      try {
        const [listing, running] = await Promise.all([
          managerApiJson<{ projects: ManagerProject[] }>('/api/projects'),
          managerApiJson<{ instances: ManagerInstance[] }>('/api/manager/running'),
        ]);
        const projects = listing.projects ?? [];
        const reason = reasonFor(projectId, projects, running.instances ?? []);
        if (reason) {
          set({ reason, projectName: projects.find((p) => p.id === projectId)?.name ?? null });
        }
      } catch {
        // The manager is unreachable too (or this document has no session, which
        // SessionExpiredOverlay owns). Nothing useful to say, so say nothing.
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  },
}));

/** Test seam — the coalescing latch outlives a store reset otherwise. */
export function resetAvailabilityProbe(): void {
  inFlight = null;
}
