/** Copy only after a UI gesture; never request clipboard read access. */
export async function copyText(value: string) {
  try {
    if (navigator.clipboard) {
      await navigator.clipboard.writeText(value);
      return;
    }
  } catch {
    // Electron denies renderer permissions by default; browsers may also deny
    // the async API. A user-initiated copy command works without relaxing them.
  }
  const focused = document.activeElement as HTMLElement | null;
  const selection = window.getSelection();
  const ranges = selection
    ? Array.from({ length: selection.rangeCount }, (_, i) => selection.getRangeAt(i).cloneRange())
    : [];
  const field = document.createElement('textarea');
  field.value = value;
  field.readOnly = true;
  field.style.cssText = 'position:fixed;left:-10000px;top:0;opacity:0';
  document.body.append(field);
  let copied = false;
  try {
    field.focus({ preventScroll: true });
    field.select();
    copied = document.execCommand('copy');
  } finally {
    field.remove();
    focused?.focus({ preventScroll: true });
    if (selection) {
      selection.removeAllRanges();
      for (const range of ranges)
        if (range.commonAncestorContainer.isConnected) selection.addRange(range);
    }
  }
  if (!copied) throw new Error('浏览器限制了复制，请选中文本后手动复制。');
}
