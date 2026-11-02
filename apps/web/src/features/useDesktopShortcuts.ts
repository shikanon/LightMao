import { useEffect, useRef } from 'react';
export type DesktopShortcutAction = 'focus-composer' | 'new-session';
interface Target {
  onFocusComposer: () => void;
  onNewSession: () => void | Promise<void>;
  onEscape?: () => void;
  disabled?: boolean;
}
const targets: { current: Target }[] = [];
let stop: (() => void) | undefined;
function action(value: DesktopShortcutAction) {
  const target = targets.at(-1)?.current;
  if (!target || document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  if (value === 'focus-composer') target.onFocusComposer();
  else if (!target.disabled) void target.onNewSession();
}
function start() {
  const native = !!window.lightmaoDesktop?.onDesktopShortcut;
  const handler = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.isComposing) return;
    const mod = event.metaKey || event.ctrlKey,
      code = event.code || 'Key' + event.key.toUpperCase();
    // Native reserved chords are handled before Electron's menu/browser default.
    // Web keeps Cmd/Ctrl+L (address bar) and Cmd/Ctrl+Shift+N (new private window).
    if (mod && code === 'KeyL' && !event.altKey && (native ? !event.shiftKey : event.shiftKey)) {
      event.preventDefault();
      action('focus-composer');
    } else if (
      mod &&
      code === 'KeyN' &&
      !event.repeat &&
      (native ? event.shiftKey && !event.altKey : event.altKey && !event.shiftKey)
    ) {
      event.preventDefault();
      action('new-session');
    } else if (event.key === 'Escape') targets.at(-1)?.current.onEscape?.();
  };
  const focus = () => action('focus-composer');
  window.addEventListener('keydown', handler, { capture: true });
  window.addEventListener('lightmao:focus-composer', focus);
  const nativeStop = window.lightmaoDesktop?.onDesktopShortcut?.(action);
  return () => {
    window.removeEventListener('keydown', handler, { capture: true });
    window.removeEventListener('lightmao:focus-composer', focus);
    nativeStop?.();
  };
}
export function useDesktopShortcuts(options: Target) {
  const target = useRef(options);
  target.current = options;
  useEffect(() => {
    targets.push(target);
    stop ||= start();
    return () => {
      const index = targets.indexOf(target);
      if (index >= 0) targets.splice(index, 1);
      if (!targets.length) {
        stop?.();
        stop = undefined;
      }
    };
  }, []);
}
export function desktopShortcutLabels() {
  const modifier = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+';
  return window.lightmaoDesktop?.onDesktopShortcut
    ? { focus: modifier + 'L', newSession: modifier + '⇧N' }
    : { focus: modifier + '⇧L', newSession: modifier + 'Alt+N' };
}
