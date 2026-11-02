export const MAX_ARTIFACT_TABS = 8;
export type WorkspaceSection =
  'preview' | 'files' | 'reference' | 'activity' | 'media' | 'trace' | 'collaboration';
export interface ArtifactViewState {
  mediaTime?: number;
  image?: { zoom: number; x: number; y: number };
  scrollTop?: number;
}
export interface ArtifactTab {
  path: string;
  revision: number;
  view: ArtifactViewState;
}
export interface ArtifactTabState {
  version: 1;
  tabs: ArtifactTab[];
  active: string;
  panelOpen: boolean;
  section: WorkspaceSection;
  expandedRuns: string[];
}
export interface WorkspaceScope {
  backend: string;
  owner: string;
  project: string;
  session: string;
}
export const emptyArtifactTabs = (): ArtifactTabState => ({
  version: 1,
  tabs: [],
  active: '',
  panelOpen: true,
  section: 'preview',
  expandedRuns: [],
});
export const artifactStorageKey = (scope: WorkspaceScope) =>
  'lightmao.artifacts.v1.' +
  [scope.backend, scope.owner, scope.project, scope.session].map(encodeURIComponent).join('|');
const validPath = (path: unknown): path is string =>
  typeof path === 'string' &&
  path.length > 0 &&
  path.length <= 1024 &&
  !path.startsWith('/') &&
  !/[\\\u0000-\u001f]/.test(path) &&
  !path.split('/').some((part) => !part || part === '.' || part === '..');
const number = (value: unknown, min: number, max: number) =>
  typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : undefined;
export function normalizeArtifactView(raw: unknown): ArtifactViewState {
  if (!raw || typeof raw !== 'object') return {};
  const v = raw as ArtifactViewState,
    mediaTime = number(v.mediaTime, 0, 86400),
    scrollTop = number(v.scrollTop, 0, 10_000_000);
  const image =
    v.image && typeof v.image === 'object'
      ? {
          zoom: number(v.image.zoom, 0.25, 4) ?? 1,
          x: number(v.image.x, -100000, 100000) ?? 0,
          y: number(v.image.y, -100000, 100000) ?? 0,
        }
      : undefined;
  return {
    ...(mediaTime === undefined ? {} : { mediaTime }),
    ...(scrollTop === undefined ? {} : { scrollTop }),
    ...(image ? { image } : {}),
  };
}
export function readArtifactTabs(raw: string | null): ArtifactTabState {
  try {
    const value = JSON.parse(raw || 'null');
    if (value?.version !== 1 || !Array.isArray(value.tabs)) return emptyArtifactTabs();
    const seen = new Set<string>(),
      tabs: ArtifactTab[] = [];
    for (const item of value.tabs.slice(0, MAX_ARTIFACT_TABS * 2)) {
      if (!item || !validPath(item.path) || seen.has(item.path)) continue;
      seen.add(item.path);
      tabs.push({
        path: item.path,
        revision: Number.isInteger(item.revision)
          ? Math.max(0, Math.min(1_000_000, item.revision))
          : 0,
        view: normalizeArtifactView(item.view),
      });
      if (tabs.length === MAX_ARTIFACT_TABS) break;
    }
    const section: WorkspaceSection = [
      'preview',
      'files',
      'reference',
      'activity',
      'media',
      'trace',
      'collaboration',
    ].includes(value.section)
      ? value.section
      : 'preview';
    const expandedRuns: string[] = Array.isArray(value.expandedRuns)
      ? value.expandedRuns
          .filter(
            (item: unknown) => typeof item === 'string' && /^[A-Za-z0-9_-]{1,150}$/.test(item),
          )
          .slice(-100)
      : [];
    return {
      version: 1,
      tabs,
      active: tabs.some((t) => t.path === value.active) ? value.active : tabs[0]?.path || '',
      panelOpen: value.panelOpen !== false,
      section,
      expandedRuns,
    };
  } catch {
    return emptyArtifactTabs();
  }
}
export function openArtifact(state: ArtifactTabState, path: string): ArtifactTabState {
  if (!validPath(path)) return state;
  if (state.tabs.some((tab) => tab.path === path)) return { ...state, active: path };
  if (state.tabs.length >= MAX_ARTIFACT_TABS) return state;
  const tabs = [...state.tabs, { path, revision: 0, view: {} }];
  return { ...state, tabs, active: path };
}
export function closeArtifact(state: ArtifactTabState, path: string): ArtifactTabState {
  const index = state.tabs.findIndex((tab) => tab.path === path),
    tabs = state.tabs.filter((tab) => tab.path !== path);
  return {
    ...state,
    tabs,
    active:
      state.active === path ? (tabs[Math.max(0, index - 1)] || tabs[0])?.path || '' : state.active,
  };
}
export function updateArtifactView(
  state: ArtifactTabState,
  path: string,
  view: ArtifactViewState,
): ArtifactTabState {
  return {
    ...state,
    tabs: state.tabs.map((tab) =>
      tab.path === path ? { ...tab, view: normalizeArtifactView({ ...tab.view, ...view }) } : tab,
    ),
  };
}
