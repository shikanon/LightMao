import { packager } from '@electron/packager';
import { createRequire } from 'node:module';
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  cp,
  rm,
  stat,
  symlink,
  readdir,
  realpath,
} from 'node:fs/promises';
import { constants, existsSync, createReadStream } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID, createHash } from 'node:crypto';
import { auditPackage, normalizePackageLinks } from './audit-package.mjs';
import { chromium } from 'playwright';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Cat } from 'lucide-react';
import { tmpdir } from 'node:os';
const run = promisify(execFile),
  require = createRequire(import.meta.url);
if (process.platform !== 'darwin' || process.arch !== 'arm64')
  throw Error('The current desktop package is verified on macOS arm64 only');
const pkg = JSON.parse(await readFile('package.json', 'utf8')),
  id = randomUUID();
await mkdir('.lightmao', { recursive: true, mode: 0o700 });
const projectRoot = resolve('.');
const developmentLinks = Object.fromEntries(
  await Promise.all(
    Object.keys(pkg.devDependencies).map(async (name) => [
      name,
      await realpath(join(projectRoot, 'node_modules', name)),
    ]),
  ),
);
const output = resolve('release', `desktop-${pkg.version}-${id}`),
  work = await mkdtemp(join(tmpdir(), 'lightmao-desktop-stage-'));
const sha256 = async (path) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(path)) hash.update(bytes);
  return hash.digest('hex');
};
const log = (stage) => console.log(JSON.stringify({ stage, id }));
await mkdir(output, { recursive: true });
try {
  log('install-locked-production-dependencies-in-independent-directory');
  const source = join(work, 'app');
  await mkdir(source);
  for (const path of [
    'package.json',
    'pnpm-lock.yaml',
    'pnpm-workspace.yaml',
    'patches',
    ...pkg.files,
  ])
    await cp(resolve(path), join(source, path), {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      mode: constants.COPYFILE_FICLONE,
    });
  const deployed = await run('pnpm', ['install', '--offline', '--prod', '--frozen-lockfile'], {
    cwd: source,
    env: { ...process.env, CI: 'true', ELECTRON_SKIP_BINARY_DOWNLOAD: '1' },
    maxBuffer: 4 * 1024 ** 2,
  });
  if (deployed.stdout) process.stdout.write(deployed.stdout);
  for (const [name, path] of Object.entries(developmentLinks))
    if ((await realpath(join(projectRoot, 'node_modules', name))) !== path)
      throw Error('Development dependency changed during packaging');
  for (const path of ['pnpm-lock.yaml', 'pnpm-workspace.yaml', 'patches'])
    await rm(join(source, path), { recursive: true, force: true });
  const manifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  delete manifest.scripts;
  delete manifest.devDependencies;
  delete manifest.packageManager;
  await writeFile(join(source, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
  const removedJunk = [];
  async function removeEditorCaches(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (entry.isSymbolicLink()) continue;
      const child = join(path, entry.name);
      if (['.vs', '.vscode', '.idea', '.git', '.DS_Store'].includes(entry.name)) {
        await rm(child, { recursive: true, force: true });
        removedJunk.push(child.slice(source.length + 1));
      } else if (entry.isDirectory()) await removeEditorCaches(child);
    }
  }
  await removeEditorCaches(join(source, 'node_modules'));
  const staged = await auditPackage(source, { sourceTree: true });
  if (
    !existsSync(join(source, 'dist/agent/index.js')) ||
    !existsSync(join(source, 'dist/runtime/file-worker.cjs'))
  )
    throw Error('Compiled Agent/helper missing from allowlisted package');
  log('create-offline-electron-archive');
  const electronVersion = JSON.parse(
    await readFile(require.resolve('electron/package.json'), 'utf8'),
  ).version;
  const electronDist = join(dirname(require.resolve('electron/package.json')), 'dist');
  const archiveName = `electron-v${electronVersion}-darwin-arm64.zip`;
  const cached = resolve('.lightmao/electron-cache', electronVersion, archiveName);
  let zipDirectory;
  if (existsSync(cached)) {
    const checksums = JSON.parse(
      await readFile(
        join(dirname(require.resolve('electron/package.json')), 'checksums.json'),
        'utf8',
      ),
    );
    if ((await sha256(cached)) !== checksums[archiveName])
      throw Error('Cached Electron archive failed its pinned checksum');
    zipDirectory = dirname(cached);
  } else {
    zipDirectory = join(work, 'electron');
    await mkdir(zipDirectory);
    if (!existsSync(join(electronDist, 'version')))
      throw Error('Install the pinned Electron runtime before packaging');
    await run('/usr/bin/ditto', [
      '-c',
      '-k',
      '--norsrc',
      electronDist,
      join(zipDirectory, archiveName),
    ]);
  }
  log('package-native-application');
  const iconset = join(work, 'LightMao.iconset');
  await mkdir(iconset);
  const master = join(work, 'icon.png'),
    browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
    const cat = renderToStaticMarkup(
      createElement(Cat, {
        color: 'white',
        strokeWidth: 1.5,
        width: 600,
        height: 600,
        style: { position: 'absolute', left: 212, top: 212 },
      }),
    );
    await page.setContent(
      `<body style="margin:0;background:transparent"><div style="width:1024px;height:1024px;background:#6b61d8;border-radius:224px;position:relative">${cat}</div></body>`,
    );
    await page.screenshot({ path: master, omitBackground: true });
  } finally {
    await browser.close();
  }
  for (const size of [16, 32, 128, 256, 512])
    for (const scale of [1, 2])
      await run('/usr/bin/sips', [
        '-z',
        String(size * scale),
        String(size * scale),
        master,
        '--out',
        join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`),
      ]);
  const icon = join(work, 'LightMao.icns');
  await run('/usr/bin/iconutil', ['-c', 'icns', '-o', icon, iconset]);
  let normalizedLinks = 0;
  const [directory] = await packager({
    dir: source,
    out: output,
    name: 'LightMao',
    executableName: 'LightMao',
    appBundleId: 'dev.lightmao.desktop',
    appVersion: pkg.version,
    platform: 'darwin',
    arch: 'arm64',
    electronVersion,
    electronZipDir: zipDirectory,
    icon,
    asar: false,
    prune: false,
    derefSymlinks: false,
    afterCopy: [
      async ({ buildPath }) => {
        normalizedLinks = await normalizePackageLinks(buildPath, source);
      },
    ],
    overwrite: false,
    osxSign: {
      identity: '-',
      identityValidation: false,
      preAutoEntitlements: false,
      optionsForFile: () => ({ hardenedRuntime: false }),
    },
    extendInfo: { LSMinimumSystemVersion: '13.0' },
  });
  const app = join(directory, 'LightMao.app');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  log('audit-final-package');
  const audited = await auditPackage(app);
  await auditPackage(join(app, 'Contents/Resources/app'), { sourceTree: true });
  log('create-disk-image');
  const image = join(work, 'image');
  await mkdir(image);
  await cp(app, join(image, 'LightMao.app'), {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    mode: constants.COPYFILE_FICLONE,
  });
  await symlink('/Applications', join(image, 'Applications'));
  const dmg = join(output, `LightMao-${pkg.version}-macos-arm64.dmg`);
  await run('/usr/bin/hdiutil', [
    'create',
    '-quiet',
    '-volname',
    'LightMao',
    '-srcfolder',
    image,
    '-format',
    'UDZO',
    dmg,
  ]);
  await run('/usr/bin/hdiutil', ['verify', '-quiet', dmg]);
  const receipt = {
    id,
    at: new Date().toISOString(),
    version: pkg.version,
    electronVersion,
    platform: 'darwin',
    arch: 'arm64',
    minimumMacOS: '13.0',
    app,
    dmg,
    dmgBytes: (await stat(dmg)).size,
    dmgSha256: await sha256(dmg),
    signing: 'ad-hoc local build; not Apple notarized',
    staged: { files: staged.files.length, bytes: staged.bytes },
    removedDependencyEditorCaches: removedJunk,
    audit: {
      files: audited.files.length,
      bytes: audited.bytes,
      links: audited.links,
      configuredSecretsAbsent: true,
      privatePathsAbsent: true,
      allLinksInsidePackage: true,
    },
    sourceWorkspaceIncluded: false,
    backendServiceIncluded: false,
    existingUserDataIncluded: false,
    developmentDependencyLinksUnchanged: true,
    normalizedDependencyLinks: normalizedLinks,
  };
  await writeFile(join(output, 'package-receipt.json'), JSON.stringify(receipt, null, 2) + '\n');
  await writeFile(
    join(output, 'file-manifest.json'),
    JSON.stringify(audited.files, null, 2) + '\n',
  );
  await writeFile(resolve('release/latest-desktop.json'), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify(receipt));
} finally {
  await rm(work, { recursive: true, force: true });
}
