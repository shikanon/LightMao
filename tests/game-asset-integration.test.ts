import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtemp,
  mkdir,
  readFile,
  writeFile,
  readdir,
  rm,
  access,
  realpath,
} from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import { IsolatedExecutor } from '../apps/agent/isolation.ts';
import { detectFfmpeg, runMediaProcess } from '../apps/agent/media-runtime.ts';
import { prepareGameAsset } from '../apps/agent/game-asset-tools.ts';

const binary = await detectFfmpeg();
const enabled = process.platform === 'darwin' && !!binary;
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
type Pixel = readonly [number, number, number, number];
/** Independent code-native PNG fixture encoder, with no production pixel helper in the test. */
function rgbaPng(width: number, height: number, paint: (x: number, y: number) => Pixel) {
  const rgba = Buffer.alloc(width * height * 4),
    rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const pixel = paint(x, y);
      rgba.set(pixel, (y * width + x) * 4);
      rows.set(pixel, y * (width * 4 + 1) + 1 + x * 4);
    }
  const chunk = (name: string, bytes: Buffer) => {
    const data = Buffer.concat([Buffer.from(name), bytes]);
    let crc = 0xffffffff;
    for (const value of data) {
      crc ^= value;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
    const size = Buffer.alloc(4),
      checksum = Buffer.alloc(4);
    size.writeUInt32BE(bytes.length);
    checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([size, data, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  return {
    rgba,
    png: Buffer.concat([
      Buffer.from('89504e470d0a1a0a', 'hex'),
      chunk('IHDR', header),
      chunk('IDAT', deflateSync(rows)),
      chunk('IEND', Buffer.alloc(0)),
    ]),
  };
}
const cell = (color: Pixel) =>
  rgbaPng(16, 16, (x, y) =>
    x >= 5 && x <= 10 && y >= 4 && y <= 11
      ? color
      : x === 4 && y === 7
        ? [color[0], color[1], color[2], 128]
        : [0, 0, 0, 0],
  );
async function tree(root: string): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isDirectory())
      for (const item of await tree(join(root, entry.name))) result.push(entry.name + '/' + item);
    else result.push(entry.name + ':' + sha(await readFile(join(root, entry.name))));
  }
  return result.sort();
}
async function fixture(
  t: TestContext,
  fn: (context: {
    root: string;
    executor: IsolatedExecutor;
    raw: (path: string) => Promise<Buffer>;
    sourceSheet: () => Promise<Buffer[]>;
  }) => Promise<void>,
) {
  if (!enabled) {
    t.skip('Requires the existing macOS isolated runner and FFmpeg; no install is attempted');
    return;
  }
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'lm-assets-integration-'))),
    root = join(directory, 'project');
  await mkdir(root);
  const executor = new IsolatedExecutor(join(directory, 'runtime'));
  let sequence = 0;
  try {
    const status = await executor.ready();
    assert.equal(status.available, true, status.error);
    await fn({
      root,
      executor,
      raw: async (path) => {
        const output = 'verified-' + ++sequence + '.rgba';
        await runMediaProcess(executor, binary!, root, [
          '-v',
          'error',
          '-i',
          path,
          '-frames:v',
          '1',
          '-f',
          'rawvideo',
          '-pix_fmt',
          'rgba',
          '-threads',
          '1',
          output,
        ]);
        return readFile(join(root, output));
      },
      sourceSheet: async () => {
        const red = cell([240, 20, 30, 255]),
          blue = cell([30, 70, 230, 255]);
        const sheet = rgbaPng(32, 16, (x, y) => {
          const pixels = x < 16 ? red.rgba : blue.rgba;
          return [
            ...pixels.subarray((y * 16 + (x % 16)) * 4, (y * 16 + (x % 16)) * 4 + 4),
          ] as unknown as Pixel;
        });
        await writeFile(join(root, 'source.png'), sheet.png);
        return [red.rgba, blue.rgba];
      },
    });
  } finally {
    await executor.close();
    await rm(directory, { recursive: true, force: true });
  }
}
const options = { skip: !enabled, timeout: 120000 };

test(
  'real FFmpeg preserves RGBA sprite cells and every atlas rect matches the independently decoded PNG and hash',
  options,
  async (t) =>
    fixture(t, async ({ root, executor, raw, sourceSheet }) => {
      const expected = await sourceSheet();
      const result = await prepareGameAsset({
        root,
        executor,
        input: {
          sourcePath: 'source.png',
          outputDir: 'sprites',
          kind: 'sprite_sheet',
          columns: 2,
          rows: 1,
          fps: 8,
          background: 'alpha',
          feather: 1.5,
          names: ['walk_00', 'walk_01'],
        },
      });
      assert.equal(result.frameCount, 2);
      assert.equal(result.technicalPassed, true);
      const manifest = JSON.parse(await readFile(join(root, 'sprites/manifest.json'), 'utf8'));
      assert.equal(manifest.alphaMode, 'straight');
      assert.deepEqual(manifest.frameSize, { width: 16, height: 16 });
      assert.equal(manifest.qa.visualAcceptance, 'pending');
      assert.equal(manifest.qa.engineAcceptance, 'not_run');
      const atlas = await raw('sprites/' + manifest.atlases[0].file);
      assert.equal(
        sha(await readFile(join(root, 'sprites', manifest.atlases[0].file))),
        manifest.atlases[0].sha256,
      );
      for (let index = 0; index < manifest.frames.length; index++) {
        const frame = manifest.frames[index],
          decoded = await raw('sprites/' + frame.file);
        assert.equal(sha(await readFile(join(root, 'sprites', frame.file))), frame.sha256);
        assert.deepEqual(
          decoded,
          expected[index],
          'alpha, partial alpha and RGB are unchanged by the complete FFmpeg/pixel/PNG pipeline',
        );
        const extracted = Buffer.alloc(16 * 16 * 4);
        for (let y = 0; y < 16; y++)
          atlas.copy(
            extracted,
            y * 16 * 4,
            ((frame.rect.y + y) * manifest.atlases[0].width + frame.rect.x) * 4,
            ((frame.rect.y + y) * manifest.atlases[0].width + frame.rect.x + 16) * 4,
          );
        assert.equal(
          sha(extracted),
          sha(decoded),
          'every atlas rectangle contains its declared frame pixels',
        );
        assert.equal(frame.durationMs, 125);
        assert(
          decoded.some((value, at) => at % 4 === 3 && value === 128),
          'real fractional alpha survives',
        );
      }
    }),
);

test(
  'same outputDir is idempotent only for exactly identical bundles and never overwrites a different request',
  options,
  async (t) =>
    fixture(t, async ({ root, executor, sourceSheet }) => {
      await sourceSheet();
      const input = {
        sourcePath: 'source.png',
        outputDir: 'icons',
        kind: 'icon_sheet' as const,
        columns: 2,
        rows: 1,
        background: 'alpha' as const,
        feather: 0,
      };
      await prepareGameAsset({ root, executor, input });
      const before = await tree(join(root, 'icons'));
      const reused = await prepareGameAsset({ root, executor, input });
      assert.equal((reused as { reused?: boolean }).reused, true);
      await assert.rejects(
        prepareGameAsset({ root, executor, input: { ...input, fps: 5 } }),
        /不同|新的outputDir/,
      );
      assert.deepEqual(await tree(join(root, 'icons')), before);
    }),
);

test(
  'rectangular icons and grids with fractional cells are rejected before any output directory is committed',
  options,
  async (t) =>
    fixture(t, async ({ root, executor }) => {
      await writeFile(
        join(root, 'rectangle.png'),
        rgbaPng(32, 18, (x, y) =>
          x % 16 > 3 && x % 16 < 12 && y > 3 && y < 14 ? [255, 0, 0, 255] : [0, 0, 0, 0],
        ).png,
      );
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: {
            sourcePath: 'rectangle.png',
            outputDir: 'invalid-icons',
            kind: 'icon_sheet',
            columns: 2,
            rows: 1,
          },
        }),
        /正方形/,
      );
      await assert.rejects(access(join(root, 'invalid-icons')));
      await writeFile(join(root, 'fractional.png'), rgbaPng(31, 16, () => [0, 0, 0, 0]).png);
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: {
            sourcePath: 'fractional.png',
            outputDir: 'fractional-icons',
            kind: 'icon_sheet',
            columns: 2,
            rows: 1,
          },
        }),
        /整除|网格/,
      );
      await assert.rejects(access(join(root, 'fractional-icons')));
    }),
);

test(
  'anchor translation that clips visible pixels produces a failed technical receipt instead of a successful alignment claim',
  options,
  async (t) =>
    fixture(t, async ({ root, executor }) => {
      await writeFile(join(root, 'actor.png'), cell([240, 20, 30, 255]).png);
      const result = await prepareGameAsset({
        root,
        executor,
        input: {
          sourcePath: 'actor.png',
          outputDir: 'clipped',
          kind: 'sprite_sheet',
          background: 'alpha',
          feather: 0,
          pivot: { x: 0.05, y: 0.05 },
          frameAnchors: [{ x: 0.5, y: 0.5 }],
        },
      });
      assert.equal(result.technicalPassed, false);
      const qa = JSON.parse(await readFile(join(root, 'clipped/qa.json'), 'utf8'));
      assert.equal(qa.technicalPassed, false);
      assert(qa.frames[0].clippedPixels > 0);
      assert(qa.warnings.some((value: string) => /裁掉|裁边/.test(value)));
      assert.equal(qa.visualAcceptance, 'pending');
      const fixed = await prepareGameAsset({
        root,
        executor,
        input: {
          sourcePath: 'actor.png',
          outputDir: 'fixed',
          replaces: 'clipped',
          kind: 'sprite_sheet',
          background: 'alpha',
          feather: 0,
        },
      });
      assert.equal(fixed.technicalPassed, true);
      assert.equal(fixed.supersedes, 'clipped');
      assert.equal(fixed.qualityKey, 'fixed');
      assert.equal(
        JSON.parse(await readFile(join(root, 'clipped/qa.json'), 'utf8')).technicalPassed,
        false,
        'failed old bundle is retained',
      );
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: {
            sourcePath: 'actor.png',
            outputDir: 'wrong-kind',
            replaces: 'clipped',
            kind: 'icon_sheet',
          },
        }),
        /同类型/,
      );
      await assert.rejects(access(join(root, 'wrong-kind')));
    }),
);

test(
  'opaque non-key artwork is rejected while real green-screen video has genuine alpha and exact requested FPS/frame count',
  options,
  async (t) =>
    fixture(t, async ({ root, executor, raw }) => {
      await writeFile(join(root, 'opaque.png'), rgbaPng(32, 32, () => [80, 20, 100, 255]).png);
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: {
            sourcePath: 'opaque.png',
            outputDir: 'false-alpha',
            kind: 'sprite_sheet',
            background: 'auto',
          },
        }),
        /不透明|背景|keyColor/,
      );
      await assert.rejects(access(join(root, 'false-alpha')));
      for (let frame = 0; frame < 8; frame++)
        await writeFile(
          join(root, 'video-' + String(frame).padStart(2, '0') + '.png'),
          rgbaPng(32, 32, (x, y) =>
            x >= 6 + frame && x < 14 + frame && y >= 6 && y < 24
              ? [255, 0, 0, 255]
              : [0, 255, 0, 255],
          ).png,
        );
      await runMediaProcess(executor, binary!, root, [
        '-v',
        'error',
        '-framerate',
        '8',
        '-i',
        'video-%02d.png',
        '-frames:v',
        '8',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        'green.mp4',
      ]);
      const result = await prepareGameAsset({
        root,
        executor,
        input: {
          sourcePath: 'green.mp4',
          outputDir: 'ultimate',
          kind: 'ultimate_video',
          fps: 4,
          background: 'chroma',
          feather: 0,
        },
      });
      assert.equal(result.frameCount, 4);
      assert.equal(result.technicalPassed, true);
      const manifest = JSON.parse(await readFile(join(root, 'ultimate/manifest.json'), 'utf8'));
      assert.equal(manifest.fps, 4);
      assert.equal(manifest.frames.length, 4);
      const centers: number[] = [];
      for (const frame of manifest.frames) {
        assert.equal(frame.durationMs, 250);
        const decoded = await raw('ultimate/' + frame.file);
        assert.equal(
          decoded[3],
          0,
          'green corner is actually transparent, rather than just labeled transparent',
        );
        const opaqueX: number[] = [];
        for (let x = 0; x < 32; x++) if (decoded[(12 * 32 + x) * 4 + 3] >= 200) opaqueX.push(x);
        assert(opaqueX.length > 0, 'the non-key foreground remains visible');
        centers.push(opaqueX[0]);
      }
      assert(
        new Set(centers).size > 1,
        'the output frames follow the actual moving source instead of repeating one generated image',
      );
    }),
);

test(
  'a video longer than 128 real output frames is rejected without silent truncation or an output commit',
  options,
  async (t) =>
    fixture(t, async ({ root, executor }) => {
      await runMediaProcess(executor, binary!, root, [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=green:s=32x32:r=1:d=130',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        'long.mp4',
      ]);
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: { sourcePath: 'long.mp4', outputDir: 'too-long', kind: 'ultimate_video', fps: 1 },
        }),
        /128帧|超过128/,
      );
      await assert.rejects(access(join(root, 'too-long')));
    }),
);

test(
  'revocation and cancellation at the final commit boundary leave the project byte-for-byte unchanged',
  options,
  async (t) =>
    fixture(t, async ({ root, executor, sourceSheet }) => {
      await sourceSheet();
      const before = await tree(root);
      let checked = 0;
      const input = {
        sourcePath: 'source.png',
        outputDir: 'denied',
        kind: 'sprite_sheet' as const,
        columns: 2,
        rows: 1,
        background: 'alpha' as const,
      };
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input,
          beforeCommit: async () => {
            checked++;
            throw Error('project permission revoked before commit');
          },
        }),
        /permission revoked/,
      );
      assert.equal(checked, 1);
      assert.deepEqual(await tree(root), before);
      const controller = new AbortController();
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: { ...input, outputDir: 'cancelled' },
          signal: controller.signal,
          beforeCommit: async () => {
            controller.abort(Error('cancelled at final boundary'));
          },
        }),
        /cancelled/,
      );
      assert.deepEqual(
        await tree(root),
        before,
        'cancelled processing cannot return a success receipt or leave a bundle',
      );
    }),
);

test(
  'source/output traversal and reserved output names do not produce a committed bundle',
  options,
  async (t) =>
    fixture(t, async ({ root, executor, sourceSheet }) => {
      await sourceSheet();
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: { sourcePath: '../source.png', outputDir: 'escape', kind: 'sprite_sheet' },
        }),
        /路径/,
      );
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: { sourcePath: 'source.png', outputDir: '../escape', kind: 'sprite_sheet' },
        }),
        /路径/,
      );
      await assert.rejects(
        prepareGameAsset({
          root,
          executor,
          input: {
            sourcePath: 'source.png',
            outputDir: 'reserved',
            kind: 'sprite_sheet',
            names: ['atlas-000'],
          },
        }),
        /保留名称/,
      );
      await assert.rejects(access(join(root, 'reserved')));
    }),
);
