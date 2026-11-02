import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeToolOutput } from '../apps/agent/tool-context.ts';
test('perception summaries retain nested findings, all four scores and unknown coverage before bulky input manifests', () => {
  const value = {
    id: 'real-job',
    status: 'completed',
    model: 'vision-model',
    inputManifest: Array.from({ length: 12 }, (_, i) => ({
      id: i,
      sha256: 'a'.repeat(64),
      bytes: 90000,
    })),
    sourceVersion: 'b'.repeat(64),
    referenceVersion: 'c'.repeat(64),
    visualScore: 21,
    result: {
      summary: 'The current screenshot does not show the required battle.',
      unknowns: ['NOT_SEEN_BOSS', 'No audio evidence'],
      scores: ['reference', 'hierarchy', 'feedback', 'coherence'].map((criterion) => ({
        criterion,
        score: 20,
        evidenceIds: ['actual-frame-0'],
        reason: 'Visible image evidence',
      })),
      observations: Array.from({ length: 32 }, () => ({
        evidenceId: 'actual-frame-0',
        text: 'Large image detail '.repeat(100),
      })),
    },
  };
  const text = summarizeToolOutput('get_perception_result', JSON.stringify(value), false);
  assert(text.length <= 1580);
  assert(text.includes('视觉评分 21/100'));
  assert(text.includes('NOT_SEEN_BOSS'));
  assert(text.includes('No audio evidence'));
  for (const id of ['reference', 'hierarchy', 'feedback', 'coherence'])
    assert(text.includes(id + ' 20/100'));
  assert(text.includes('The current screenshot'));
  assert(!text.includes('inputManifest'));
});
