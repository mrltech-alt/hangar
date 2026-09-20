import { create } from 'zustand';
import type { Agent, Folder, Id, Project, WorkspaceSnapshot } from '../../../shared/types.ts';

interface WorkspaceState {
  snapshot: WorkspaceSnapshot | null;
  setSnapshot: (s: WorkspaceSnapshot) => void;
}

export const useWorkspace = create<WorkspaceState>((set) => ({
  snapshot: null,
  setSnapshot: (snapshot) => set({ snapshot }),
}));

export const useAgent = (id: Id | null): Agent | undefined => useWorkspace((s) => (id === null ? undefined : s.snapshot?.workspace.agents.find((a) => a.id === id)));
export const useProject = (id: Id | null): Project | undefined => useWorkspace((s) => (id === null ? undefined : s.snapshot?.workspace.projects.find((p) => p.id === id)));
export const useProjects = (): Project[] => useWorkspace((s) => s.snapshot?.workspace.projects ?? EMPTY_PROJECTS);
const EMPTY_PROJECTS: Project[] = [];
export const useFolders = (): Folder[] => useWorkspace((s) => s.snapshot?.workspace.folders ?? EMPTY_FOLDERS);
const EMPTY_FOLDERS: Folder[] = [];
