import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { currentAuthUser } from '../api';
import { createUiStateMirror, type UiStateMirror } from './desktop-ui-persistence';
import {
  conversationStateKey,
  readConversationPosition,
  writeConversationPosition,
  type ConversationScope,
} from './desktop-session-state';
export function useConversationViewport({
  scope,
  composerRef,
  persistent = false,
  notify,
}: {
  scope: ConversationScope;
  composerRef: RefObject<HTMLTextAreaElement | null>;
  persistent?: boolean;
  notify?: (message: string) => void;
}) {
  const key = conversationStateKey(scope),
    scrollRef = useRef<HTMLDivElement>(null),
    followingRef = useRef(true),
    restoring = useRef(false),
    focused = useRef(false);
  const selection = useRef({ start: 0, end: 0 }),
    mirror = useRef<UiStateMirror | undefined>(undefined),
    focusPending = useRef(false),
    activeKey = useRef(key),
    touched = useRef(false);
  activeKey.current = key;
  const [following, setFollowing] = useState(true);
  const schedule = useRef(0),
    saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    // Streaming follows immediately. A CSS smooth scroll leaves an animation
    // running after the reader scrolls up and can move their reading position.
    const previousScrollBehavior = node.style.scrollBehavior;
    node.style.scrollBehavior = 'auto';
    let revoked = false;
    let previous = readConversationPosition(sessionStorage, key);
    const composer = composerRef.current;
    restoring.current = true;
    followingRef.current = previous?.following ?? true;
    focused.current = previous?.focused ?? false;
    setFollowing(followingRef.current);
    selection.current = { start: previous?.selectionStart || 0, end: previous?.selectionEnd || 0 };
    const save = () => {
      // Focus/select can arrive before a scroll debounce fires. That older
      // snapshot must not overwrite the newer caret state in the mirror.
      clearTimeout(saveTimer.current);
      saveTimer.current = undefined;
      if (revoked || currentAuthUser() !== scope.ownerId) return;
      // React can remove this keyed message node before layout cleanup. Its
      // scrollTop then becomes zero; keep the last observed reading position.
      const state = node.isConnected
        ? {
            top: node.scrollTop,
            following: followingRef.current,
            focused: focused.current,
            selectionStart: selection.current.start,
            selectionEnd: selection.current.end,
          }
        : readConversationPosition(sessionStorage, key);
      if (!state) return;
      writeConversationPosition(sessionStorage, key, state);
      mirror.current?.write({ ...state });
    };
    focusPending.current = previous?.focused === true;
    touched.current = false;
    if (persistent) {
      const current = createUiStateMirror(scope, 'viewport', {
        restored: (value) => {
          if (revoked || activeKey.current !== key || touched.current || !value) return;
          const stored = readConversationPosition(
            {
              getItem: () => JSON.stringify(value),
              setItem() {},
              removeItem() {},
              key: () => null,
              length: 0,
            },
            key,
          );
          if (!stored) return;
          previous = stored;
          restoring.current = true;
          followingRef.current = stored.following;
          focused.current = stored.focused;
          focusPending.current = stored.focused;
          selection.current = { start: stored.selectionStart || 0, end: stored.selectionEnd || 0 };
          setFollowing(stored.following);
          node.scrollTop = stored.following ? node.scrollHeight : stored.top;
          requestAnimationFrame(() => {
            restoring.current = false;
          });
        },
        error: (message) => {
          if (!revoked && activeKey.current === key) notify?.(message);
        },
      });
      mirror.current = current;
    }
    const position = () => {
      if (followingRef.current) node.scrollTop = node.scrollHeight;
      else node.scrollTop = previous?.top || 0;
    };
    position();
    const ready = requestAnimationFrame(() => {
      position();
      restoring.current = false;
      if (
        previous?.focused &&
        composer &&
        !composer.disabled &&
        !document.querySelector('[role="dialog"][aria-modal="true"]')
      ) {
        const { start, end } = selection.current;
        composer.focus({ preventScroll: true });
        composer.setSelectionRange(start, end);
        focusPending.current = document.activeElement !== composer;
      }
    });
    const update = () => {
      if (!followingRef.current || restoring.current) return;
      cancelAnimationFrame(schedule.current);
      schedule.current = requestAnimationFrame(() => {
        if (followingRef.current) node.scrollTop = node.scrollHeight;
      });
    };
    const resize = new ResizeObserver(update),
      observe = () => {
        resize.disconnect();
        for (const child of Array.from(node.children).slice(-200)) resize.observe(child);
        update();
      };
    const mutation = new MutationObserver(observe);
    mutation.observe(node, { childList: true, subtree: true, characterData: true });
    observe();
    const remember = () => {
      if (!composer || restoring.current) return;
      touched.current = true;
      focused.current = true;
      selection.current = { start: composer.selectionStart, end: composer.selectionEnd };
      save();
    };
    composer?.addEventListener('focus', remember);
    composer?.addEventListener('select', remember);
    composer?.addEventListener('keyup', remember);
    composer?.addEventListener('input', remember);
    const unfocus = () => {
      focused.current = false;
      focusPending.current = false;
      touched.current = true;
    };
    const clear = () => {
      revoked = true;
      mirror.current?.dispose();
    };
    node.addEventListener('pointerdown', unfocus);
    window.addEventListener('lightmao:auth-cleared', clear);
    window.addEventListener('pagehide', save);
    return () => {
      clearTimeout(saveTimer.current);
      cancelAnimationFrame(ready);
      cancelAnimationFrame(schedule.current);
      resize.disconnect();
      mutation.disconnect();
      composer?.removeEventListener('focus', remember);
      composer?.removeEventListener('select', remember);
      composer?.removeEventListener('keyup', remember);
      composer?.removeEventListener('input', remember);
      window.removeEventListener('pagehide', save);
      window.removeEventListener('lightmao:auth-cleared', clear);
      node.removeEventListener('pointerdown', unfocus);
      save();
      mirror.current?.dispose();
      mirror.current = undefined;
      node.style.scrollBehavior = previousScrollBehavior;
    };
  }, [key, composerRef, persistent]);
  useLayoutEffect(() => {
    const composer = composerRef.current;
    if (
      focusPending.current &&
      composer &&
      !composer.disabled &&
      !document.querySelector('[role="dialog"][aria-modal="true"]')
    ) {
      const { start, end } = selection.current;
      composer.focus({ preventScroll: true });
      composer.setSelectionRange(start, end);
      focusPending.current = document.activeElement !== composer;
    }
  });
  const onScroll = useCallback(() => {
    const node = scrollRef.current;
    if (!node || restoring.current) return;
    touched.current = true;
    const next = node.scrollHeight - node.clientHeight - node.scrollTop < 80;
    if (followingRef.current !== next) {
      followingRef.current = next;
      setFollowing(next);
    }
    if (!next) {
      focused.current = false;
      focusPending.current = false;
    }
    clearTimeout(saveTimer.current);
    const state = {
      top: node.scrollTop,
      following: next,
      focused: focused.current,
      selectionStart: selection.current.start,
      selectionEnd: selection.current.end,
    };
    if (currentAuthUser() === scope.ownerId) writeConversationPosition(sessionStorage, key, state);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = undefined;
      if (currentAuthUser() === scope.ownerId && activeKey.current === key) {
        const latest = readConversationPosition(sessionStorage, key);
        if (latest) mirror.current?.write({ ...latest });
      }
    }, 120);
  }, [key]);
  const scrollToLatest = useCallback(() => {
    const node = scrollRef.current;
    if (!node) return;
    followingRef.current = true;
    setFollowing(true);
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  }, []);
  return { scrollRef, onScroll, following, followBottom: following, scrollToLatest };
}
