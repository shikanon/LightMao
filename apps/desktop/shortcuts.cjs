const CHANNEL = 'lightmao:desktop-shortcut';
function shortcutAction(input, platform = process.platform) {
  if (input.type !== 'keyDown' || input.isAutoRepeat || input.isComposing || input.alt) return;
  const modifier =
    platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta;
  if (!modifier) return;
  const key = String(input.key || '').toLowerCase();
  if (key === 'l' && !input.shift) return 'focus-composer';
  if (key === 'n' && input.shift) return 'new-session';
}
function registerDesktopShortcuts(win, origin) {
  win.webContents.on('before-input-event', (event, input) => {
    const action = shortcutAction(input);
    if (!action || win.isDestroyed()) return;
    try {
      if (new URL(win.webContents.getURL()).origin !== origin) return;
    } catch {
      return;
    }
    event.preventDefault();
    win.webContents.send(CHANNEL, action);
  });
}
module.exports = { shortcutAction, registerDesktopShortcuts };
