const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld(
  'lightmaoDesktop',
  Object.freeze({
    version: 1,
    onDesktopShortcut: (listener) => {
      if (typeof listener !== 'function') return () => {};
      const handler = (_, action) => {
        if (action === 'focus-composer' || action === 'new-session') listener(action);
      };
      ipcRenderer.on('lightmao:desktop-shortcut', handler);
      return () => ipcRenderer.removeListener('lightmao:desktop-shortcut', handler);
    },
    backendStatus: () => ipcRenderer.invoke('lightmao:backend-status'),
    probeBackend: (url) => ipcRenderer.invoke('lightmao:probe-backend', url),
    setBackend: (request) => ipcRenderer.invoke('lightmao:set-backend', request),
    runtimeStatus: () => ipcRenderer.invoke('lightmao:runtime-status'),
    setBackground: (enabled) => ipcRenderer.invoke('lightmao:set-background', enabled),
    selectProjectDirectory: (request) =>
      ipcRenderer.invoke('lightmao:select-project-directory', request),
    selectMcpFile: (request) => ipcRenderer.invoke('lightmao:select-mcp-file', request),
    selectSkillDirectory: (request) =>
      ipcRenderer.invoke('lightmao:select-skill-directory', request),
    selectGodot: (request) => ipcRenderer.invoke('lightmao:select-godot', request),
    revealProjectPath: (request) => ipcRenderer.invoke('lightmao:reveal-project-path', request),
    openProjectDocument: (request) => ipcRenderer.invoke('lightmao:open-project-document', request),
  }),
);
