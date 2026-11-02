import { mkdtemp, mkdir, readFile, writeFile, cp, rm, readdir, realpath } from 'node:fs/promises';
import { constants, createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { auditPackage, normalizePackageLinks } from './audit-package.mjs';
import { selectBackendDependencies } from './backend-package-deps.mjs';

const run = promisify(execFile),
  id = randomUUID(),
  project = resolve('.');
const pkg = JSON.parse(await readFile('package.json', 'utf8'));
const output = resolve('release', `backend-${pkg.version}-${id}`);
const work = await mkdtemp(join(tmpdir(), 'lightmao-backend-stage-'));
const source = join(work, 'lightmao-backend');
const required = JSON.parse(await readFile('dist/api/dependencies.json', 'utf8'));
if (!required.length || required.some((name) => !Object.hasOwn(pkg.dependencies, name)))
  throw Error('API runtime imports must be declared and locked production dependencies');
const before = Object.fromEntries(
  await Promise.all(
    Object.keys(pkg.devDependencies).map(async (name) => [
      name,
      await realpath(join(project, 'node_modules', name)),
    ]),
  ),
);
const env = { ...process.env, CI: 'true', COPYFILE_DISABLE: '1' };
for (const name of Object.keys(env))
  if (/^(ARK_|OSS_|DOUBAO_|LIGHTMAO_ADMIN_)/.test(name)) delete env[name];
await mkdir(output, { recursive: true });
await mkdir(source);
try {
  const manifest = {
    name: 'lightmao-backend',
    private: true,
    type: 'module',
    version: pkg.version,
    engines: pkg.engines,
    scripts: { start: 'node dist/api/index.js' },
    dependencies: Object.fromEntries(required.map((name) => [name, pkg.dependencies[name]])),
  };
  // Reuse the original policy-checked lock byte-for-byte. A rewritten subset
  // would need registry metadata, even with every package available offline.
  for (const path of ['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches'])
    await cp(resolve(path), join(source, path), { recursive: true });
  const installed = await run(
    'pnpm',
    ['install', '--offline', '--prod', '--frozen-lockfile', '--ignore-scripts'],
    { cwd: source, env, maxBuffer: 2 * 1024 ** 2 },
  );
  process.stdout.write(installed.stdout);
  for (const [name, path] of Object.entries(before))
    if ((await realpath(join(project, 'node_modules', name))) !== path)
      throw Error('Development dependencies changed');
  const dependencyGraph = await selectBackendDependencies(source, required);
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  for (const path of ['pnpm-workspace.yaml', 'pnpm-lock.yaml', 'patches'])
    await rm(join(source, path), { recursive: true });
  const removed = [];
  async function strip(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (['.vs', '.vscode', '.idea', '.git', '.DS_Store'].includes(entry.name)) {
        await rm(child, { recursive: true, force: true });
        removed.push(child.slice(source.length + 1));
      } else if (entry.isDirectory()) await strip(child);
    }
  }
  await strip(join(source, 'node_modules'));
  await normalizePackageLinks(source, source);
  for (const path of ['dist/api/index.js', 'dist/web', 'deploy', 'LICENSE'])
    await cp(resolve(path), join(source, path), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  await mkdir(join(source, 'tools'));
  await cp('scripts/backend-data.mjs', join(source, 'tools/backend-data.mjs'));
  await cp('deploy/README.md', join(source, 'README.md'));
  const audit = await auditPackage(source);
  for (const file of audit.files) {
    if (
      !/^(?:node_modules\/|dist\/(?:api\/index\.js$|web\/)|deploy\/|tools\/backend-data\.mjs$|package\.json$|README\.md$|LICENSE$)/.test(
        file.path,
      ) ||
      /\.node$/.test(file.path)
    )
      throw Error('Unexpected or native backend dependency: ' + file.path);
  }
  const archive = join(output, `LightMao-${pkg.version}-backend-node24.tar.gz`);
  await run('tar', ['-czf', archive, '-C', work, 'lightmao-backend'], {
    env,
    maxBuffer: 1024 ** 2,
  });
  const hash = createHash('sha256');
  let bytes = 0;
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk);
    bytes += chunk.length;
  }
  const receipt = {
    id,
    at: new Date().toISOString(),
    version: pkg.version,
    archive,
    bytes,
    sha256: hash.digest('hex'),
    node: '>=24',
    runtimeIncluded: false,
    dependencies: required,
    dependencyGraph,
    audit: {
      files: audit.files.length,
      bytes: audit.bytes,
      links: audit.links,
      configuredSecretsAbsent: true,
      privatePathsAbsent: true,
      allLinksInsidePackage: true,
    },
    removedDependencyEditorCaches: removed,
    developmentDependencyLinksUnchanged: true,
    scope:
      'Single API instance with SQLite; package built locally. Linux service/proxy and public deployment require separate verification.',
  };
  await writeFile(join(output, 'package-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(join(output, 'file-manifest.json'), JSON.stringify(audit.files, null, 2) + '\n');
  await writeFile('release/latest-backend.json', JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  await rm(work, { recursive: true, force: true });
}
