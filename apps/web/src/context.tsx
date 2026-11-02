import { createContext, useContext } from 'react';
import type {
  CloudBootstrap,
  LocalBootstrap,
  SessionView,
  SkillSummary,
} from '../../../packages/shared/types';
export type Page =
  | 'workspace'
  | 'projects'
  | 'engines'
  | 'sessions'
  | 'plugins'
  | 'skills'
  | 'assets'
  | 'schedules'
  | 'settings'
  | 'admin';
export interface WorkspaceContext {
  cloud: CloudBootstrap;
  local: LocalBootstrap;
  skills: SkillSummary[];
  session?: SessionView;
  sessionLoading: boolean;
  sessionError: string;
  focusMessageId?: string;
  activeSessionId: string;
  page: Page;
  setPage: (p: Page) => void;
  openSession: (id: string, messageId?: string) => void;
  refresh: () => Promise<void>;
  notify: (s: string) => void;
  perform: <T>(work: () => Promise<T>, success?: string) => Promise<T | undefined>;
  newSession: (projectId?: string) => Promise<void>;
  creatingSession: boolean;
  logout: () => void;
}
export const Workspace = createContext<WorkspaceContext | null>(null);
export const useWorkspace = () => {
  const value = useContext(Workspace);
  if (!value) throw new Error('Missing workspace');
  return value;
};
