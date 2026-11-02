import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

test('private configuration stays ignored and mode 0600; Git guard blocks forced secrets and historical private files', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lightmao-secret-guard-'));
  const config = resolve('scripts/configure-private.mjs'),
    check = resolve('scripts/check-secrets.mjs');
  const secret = 'fixture-private-key-123456789012345678901234567890';
  const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
  try {
    git('init', '--quiet');
    await mkdir(join(dir, 'docs'));
    await writeFile(join(dir, '.gitignore'), 'docs/password.md\n.env\n');
    await writeFile(
      join(dir, 'docs/password.md'),
      `火山引擎方舟apikey:\n${secret}\nOSS_REGION=oss-cn-beijing\nOSS_BUCKET=test-bucket\n`,
    );
    const configured = spawnSync(process.execPath, [config], { cwd: dir, encoding: 'utf8' });
    assert.equal(configured.status, 0, configured.stderr);
    assert(!configured.stdout.includes(secret));
    assert((await readFile(join(dir, '.env'), 'utf8')).includes(secret));
    assert.equal((await stat(join(dir, '.env'))).mode & 0o777, 0o600);
    assert.equal(spawnSync(process.execPath, [check], { cwd: dir }).status, 0);
    git('add', '-f', 'docs/password.md');
    const forced = spawnSync(process.execPath, [check], { cwd: dir, encoding: 'utf8' });
    assert.equal(forced.status, 1);
    assert(forced.stderr.includes('private file'));
    assert(!forced.stderr.includes(secret));
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-qm',
      'private fixture for guard test',
    );
    git('rm', '--cached', 'docs/password.md');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '-qm',
      'remove fixture',
    );
    const history = spawnSync(process.execPath, [check, '--history'], {
      cwd: dir,
      encoding: 'utf8',
    });
    assert.equal(history.status, 1);
    assert(history.stderr.includes('Git history'));
    const privateCommit = git('rev-parse', 'HEAD').toString().trim();
    git('update-ref', 'refs/codex/local-backup', privateCommit);
    git('checkout', '--orphan', 'clean-branch');
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.test',
      'commit',
      '--allow-empty',
      '-qm',
      'clean history',
    );
    assert.equal(
      spawnSync(process.execPath, [check, '--history'], { cwd: dir }).status,
      0,
      'ordinary pushes only include reachable branch history',
    );
    const mirror = spawnSync(process.execPath, [check, '--pre-push'], {
      cwd: dir,
      encoding: 'utf8',
      input: `refs/codex/local-backup ${privateCommit} refs/codex/local-backup ${'0'.repeat(40)}\n`,
    });
    assert.equal(mirror.status, 1, 'explicitly pushing private backup refs must be blocked');
    await writeFile(join(dir, 'leak.ts'), `export const accidental='${secret}'`);
    const leak = spawnSync(process.execPath, [check], { cwd: dir, encoding: 'utf8' });
    assert.equal(leak.status, 1);
    assert(leak.stderr.includes('leak.ts'));
    assert(!leak.stderr.includes(secret));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
