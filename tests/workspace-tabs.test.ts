import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  artifactStorageKey,
  closeArtifact,
  emptyArtifactTabs,
  openArtifact,
  readArtifactTabs,
  updateArtifactView,
} from '../apps/web/src/features/workspace-tabs.ts';

test('artifact navigation keeps a bounded ordered workspace and selects a neighbor after close', () => {
  let state = emptyArtifactTabs();
  for (const name of ['design.md', 'hero.png', 'battle.mp4', 'level.html', 'hero.glb'])
    state = openArtifact(state, name);
  state = updateArtifactView(state, 'battle.mp4', { mediaTime: 38.5 });
  state = updateArtifactView(state, 'hero.png', { image: { zoom: 2, x: 24, y: -10 } });
  state = openArtifact(state, 'hero.png');
  assert.equal(state.tabs.length, 5, 'reopening an existing path must not duplicate a tab');
  assert.equal(state.active, 'hero.png');
  state = closeArtifact(state, 'hero.png');
  assert.equal(state.active, 'design.md');
  assert.equal(state.tabs.find((tab) => tab.path === 'battle.mp4')?.view.mediaTime, 38.5);
  for (let n = 0; n < 12; n++) state = openArtifact(state, `pages/document-${n}.md`);
  assert.equal(state.tabs.length, 8);
  assert.equal(state.active, 'pages/document-3.md');
  assert(state.tabs.some((tab) => tab.path === state.active));
  assert(
    state.tabs.some((tab) => tab.path === 'design.md'),
    'a full tab strip never silently closes an existing artifact',
  );
});

test('restoring a desktop workspace retains real view state while rejecting unsafe and oversized cached metadata', () => {
  let state = openArtifact(openArtifact(emptyArtifactTabs(), 'clip.mp4'), 'portrait.png');
  state = updateArtifactView(state, 'clip.mp4', { mediaTime: 12.75 });
  state = updateArtifactView(state, 'portrait.png', {
    image: { zoom: 1.75, x: 50, y: -25 },
    scrollTop: 240,
  });
  state = { ...state, section: 'reference', panelOpen: false, expandedRuns: ['run-original'] };
  assert.deepEqual(readArtifactTabs(JSON.stringify(state)), state);
  const corrupted = readArtifactTabs(
    JSON.stringify({
      version: 1,
      active: '../private.txt',
      section: 'injected',
      tabs: [
        { path: '../private.txt' },
        { path: '/etc/passwd' },
        { path: 'folder\\escape.png' },
        {
          path: 'safe.md',
          view: {
            mediaTime: -20,
            image: { zoom: 100, x: 1e9, y: 'bad' },
            secret: 'must not survive',
          },
        },
        { path: 'safe.md' },
      ],
    }),
  );
  assert.equal(corrupted.tabs.length, 1);
  assert.equal(corrupted.active, 'safe.md');
  assert.equal(corrupted.section, 'preview');
  assert.deepEqual(corrupted.tabs[0].view, { mediaTime: 0, image: { zoom: 4, x: 100000, y: 0 } });
  assert.deepEqual(readArtifactTabs('{broken'), emptyArtifactTabs());
  assert.deepEqual(readArtifactTabs('{"version":999,"tabs":[]}'), emptyArtifactTabs());
});

test('workspace metadata never shares a key across a backend, account, project or chat boundary', () => {
  const scope = {
    backend: 'device:ark-production',
    owner: 'alice',
    project: 'same-project',
    session: 'same-session',
  };
  const key = artifactStorageKey(scope);
  for (const changed of [
    { backend: 'device:local-fixture' },
    { owner: 'bob' },
    { project: 'another-project' },
    { session: 'forked-session' },
  ])
    assert.notEqual(artifactStorageKey({ ...scope, ...changed }), key);
});
