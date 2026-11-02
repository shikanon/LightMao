import { ApiError, currentAccessToken, currentAuthUser, refreshAccess } from './api';
import type {
  ProjectDirectoryGrant,
  McpFileGrant,
  SkillImportPreview,
  EngineGrant,
} from '../../../packages/shared/types';

type Result<T> =
  { ok: true; value: T } | { ok: false; status: number; code?: string; error: string };
export interface DesktopRuntimeStatus {
  keepRunning: boolean;
  trayAvailable: boolean;
  agentOnline: boolean;
  ownsAgent: boolean;
  resumeAt?: string;
}
export interface BackendConnectionStatus {
  url: string;
  configured: boolean;
  revision: number;
  readOnly: boolean;
  managed: boolean;
  packaged: boolean;
  error?: string;
}
export interface BackendProbe {
  url: string;
  service: string;
  protocolVersion: number;
  demoAllowed: boolean;
  durationMs: number;
}
declare global {
  interface Window {
    lightmaoDesktop?: {
      version: number;
      onDesktopShortcut?: (
        listener: (action: 'focus-composer' | 'new-session') => void,
      ) => () => void;
      backendStatus?: () => Promise<Result<BackendConnectionStatus>>;
      probeBackend?: (url: string) => Promise<Result<BackendProbe>>;
      setBackend?: (input: {
        url: string;
        revision: number;
      }) => Promise<Result<{ changed: boolean; restart: boolean }>>;
      selectGodot?: (input: {
        token: string;
        projectId: string;
      }) => Promise<Result<EngineGrant | null>>;
      selectSkillDirectory?: (input: {
        token: string;
        replaceId?: string;
      }) => Promise<Result<SkillImportPreview | null>>;
      runtimeStatus?: () => Promise<DesktopRuntimeStatus>;
      setBackground?: (enabled: boolean) => Promise<DesktopRuntimeStatus>;
      selectMcpFile: (input: {
        token: string;
        projectId: string;
      }) => Promise<Result<McpFileGrant | null>>;
      selectProjectDirectory: (input: {
        token: string;
        access: 'read' | 'write';
        projectId?: string;
      }) => Promise<Result<ProjectDirectoryGrant | null>>;
      revealProjectPath: (input: {
        token: string;
        projectId: string;
        path?: string;
      }) => Promise<Result<null>>;
      openProjectDocument: (input: {
        token: string;
        projectId: string;
        path: string;
      }) => Promise<Result<null>>;
    };
  }
}
export const hasDesktopActions = () => window.lightmaoDesktop?.version === 1;
export const hasDesktopBackground = () =>
  typeof window.lightmaoDesktop?.runtimeStatus === 'function';
export const desktopRuntimeStatus = () => window.lightmaoDesktop!.runtimeStatus!();
export const setDesktopBackground = (enabled: boolean) =>
  window.lightmaoDesktop!.setBackground!(enabled);
export const hasBackendSettings = () => typeof window.lightmaoDesktop?.backendStatus === 'function';
async function backendResult<T>(work: Promise<Result<T>>) {
  const result = await work;
  if (!result.ok) throw new ApiError(result.error, result.status, result.code);
  return result.value;
}
export const desktopBackendStatus = () => backendResult(window.lightmaoDesktop!.backendStatus!());
export const probeDesktopBackend = (url: string) =>
  backendResult(window.lightmaoDesktop!.probeBackend!(url));
export const setDesktopBackend = (url: string, revision: number) =>
  backendResult(window.lightmaoDesktop!.setBackend!({ url, revision }));
async function invoke<T>(work: (token: string) => Promise<Result<T>>) {
  if (!hasDesktopActions()) throw new Error('请在 LightMao 桌面端选择本地项目目录');
  const owner = currentAuthUser();
  let result = await work(currentAccessToken());
  if (!result.ok && result.status === 401 && (await refreshAccess())) {
    if (currentAuthUser() !== owner)
      throw new ApiError('账号已切换，请重新操作', 401, 'ACCOUNT_CHANGED');
    result = await work(currentAccessToken());
  }
  if (currentAuthUser() !== owner)
    throw new ApiError('账号已切换，请重新操作', 401, 'ACCOUNT_CHANGED');
  if (!result.ok) throw new ApiError(result.error, result.status, result.code);
  return result.value;
}
export function selectProjectDirectory(access: 'read' | 'write', projectId?: string) {
  return invoke((token) =>
    window.lightmaoDesktop!.selectProjectDirectory({ token, access, projectId }),
  );
}
export function revealProjectPath(projectId: string, path?: string) {
  return invoke((token) => window.lightmaoDesktop!.revealProjectPath({ token, projectId, path }));
}
export function openProjectDocument(projectId: string, path: string) {
  return invoke((token) => window.lightmaoDesktop!.openProjectDocument({ token, projectId, path }));
}
export function selectMcpFile(projectId: string) {
  return invoke((token) => window.lightmaoDesktop!.selectMcpFile({ token, projectId }));
}
export const hasNativeSkillImport = () =>
  typeof window.lightmaoDesktop?.selectSkillDirectory === 'function';
export function selectSkillDirectory(replaceId?: string) {
  return invoke((token) => window.lightmaoDesktop!.selectSkillDirectory!({ token, replaceId }));
}
export const hasNativeEngineSelection = () =>
  typeof window.lightmaoDesktop?.selectGodot === 'function';
export function selectGodot(projectId: string) {
  return invoke((token) => window.lightmaoDesktop!.selectGodot!({ token, projectId }));
}
