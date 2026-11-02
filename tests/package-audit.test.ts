import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
const { auditPackage, normalizePackageLinks } = await import(
  new URL('../scripts/audit-package.mjs', import.meta.url).href
);
test('relocated dependency links are made relative and self-contained before signing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-package-links-')),
    source = join(dir, 'source'),
    target = join(dir, 'target');
  try {
    for (const root of [source, target]) {
      await mkdir(join(root, 'node_modules/lib'), { recursive: true });
      await writeFile(join(root, 'node_modules/lib/index.js'), 'module.exports=1');
    }
    await symlink(join(source, 'node_modules/lib'), join(target, 'node_modules/alias'));
    await assert.rejects(() => auditPackage(target), /External package link/);
    assert.equal(await normalizePackageLinks(target, source), 1);
    await rm(source, { recursive: true });
    assert.equal((await auditPackage(target)).allLinksInsidePackage, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('package audit accepts contained production links and rejects external links, private data and unexpected source files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-package-audit-')),
    root = join(dir, 'app');
  try {
    await mkdir(join(root, 'node_modules/lib'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{}');
    await writeFile(join(root, 'node_modules/lib/index.js'), 'export default 1');
    await symlink('lib', join(root, 'node_modules/alias'));
    const result = await auditPackage(root, { sourceTree: true });
    assert.equal(result.files.length, 2);
    assert.equal(result.links, 1);
    await writeFile(join(dir, 'outside'), 'outside');
    await symlink(join(dir, 'outside'), join(root, 'outside-link'));
    await assert.rejects(() => auditPackage(root), /External package link/);
    await rm(join(root, 'outside-link'));
    await writeFile(join(root, '.env'), 'private');
    await assert.rejects(() => auditPackage(root), /Private path/);
    await rm(join(root, '.env'));
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await writeFile(join(root, 'apps/api/server.js'), 'not a desktop file');
    await assert.rejects(
      () => auditPackage(root, { sourceTree: true }),
      /Unexpected application file/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
test('package audit finds configured secrets in binary chunks and across read boundaries without echoing them', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lm-package-secret-')),
    previous = process.env.LIGHTMAO_ADMIN_PASSWORD;
  const secret = 'package-canary-' + randomUUID();
  process.env.LIGHTMAO_ADMIN_PASSWORD = secret;
  try {
    await writeFile(
      join(dir, 'binary'),
      Buffer.concat([Buffer.alloc(256 * 1024 - 5), Buffer.from(secret), Buffer.alloc(10)]),
    );
    await assert.rejects(
      () => auditPackage(dir),
      (error: Error) =>
        error.message.includes('Configured secret') && !error.message.includes(secret),
    );
  } finally {
    if (previous === undefined) delete process.env.LIGHTMAO_ADMIN_PASSWORD;
    else process.env.LIGHTMAO_ADMIN_PASSWORD = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
