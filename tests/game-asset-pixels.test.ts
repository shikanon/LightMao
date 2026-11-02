import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deflateSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  encodePng,
  decodePng,
  prepareFrame,
  cropGrid,
  type RgbaImage,
} from '../apps/agent/game-asset-pixels.ts';
import {
  encodePng as sharedEncode,
  decodePng as sharedDecode,
} from '../packages/shared/rgba-png.ts';

function image(width: number, height: number, color: number[] = [0, 0, 0, 0]): RgbaImage {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(color, i * 4);
  return { width, height, data };
}
const pixel = (v: RgbaImage, x: number, y: number) => [
  ...v.data.subarray((y * v.width + x) * 4, (y * v.width + x) * 4 + 4),
];
const put = (v: RgbaImage, x: number, y: number, color: number[]) =>
  v.data.set(color, (y * v.width + x) * 4);
function chunk(name: string | Buffer, data = Buffer.alloc(0)) {
  const type = Buffer.isBuffer(name) ? name : Buffer.from(name),
    result = Buffer.alloc(data.length + 12);
  result.writeUInt32BE(data.length);
  result.set(type, 4);
  result.set(data, 8);
  let crc = 0xffffffff;
  for (const byte of Buffer.concat([type, data])) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4);
  return result;
}
function ihdr(width = 1, height = 1, color = 6, depth = 8, interlace = 0) {
  const data = Buffer.alloc(13);
  data.writeUInt32BE(width);
  data.writeUInt32BE(height, 4);
  data[8] = depth;
  data[9] = color;
  data[12] = interlace;
  return chunk('IHDR', data);
}
const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const png = (...chunks: Buffer[]) => Buffer.concat([signature, ...chunks]);
const simplePng = (raw = Buffer.from([0, 20, 30, 40, 255]), header = ihdr()) =>
  png(header, chunk('IDAT', deflateSync(raw)), chunk('IEND'));

test('lossless PNG preserves hidden RGB and fractional alpha; shared exports are the same codec', () => {
  assert.equal(sharedEncode, encodePng);
  assert.equal(sharedDecode, decodePng);
  const source = image(7, 5);
  for (let at = 0; at < source.data.length; at++) source.data[at] = (at * 43) % 256;
  const encoded = encodePng(source),
    decoded = decodePng(encoded);
  assert.deepEqual(decoded, source);
  assert.notEqual(decoded.data, source.data);
  assert.deepEqual([...source.data], [...decoded.data]);
  const largestEdge = image(4096, 1, [9, 13, 17, 71]);
  assert.deepEqual(decodePng(encodePng(largestEdge)), largestEdge);
});

test('PNG accepts independently encoded RGB/RGBA filters 0..4 and RGB tRNS', () => {
  for (const channels of [3, 4]) {
    const width = 4,
      height = 5,
      stride = width * channels,
      values = Buffer.from(Array.from({ length: stride * height }, (_, at) => (at * 31) % 256)),
      raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
      raw[y * (stride + 1)] = y;
      for (let x = 0; x < stride; x++) {
        const at = y * stride + x,
          left = x >= channels ? values[at - channels] : 0,
          up = y ? values[at - stride] : 0,
          ul = y && x >= channels ? values[at - stride - channels] : 0;
        const p = left + up - ul,
          distances = [Math.abs(p - left), Math.abs(p - up), Math.abs(p - ul)],
          paeth =
            distances[0] <= distances[1] && distances[0] <= distances[2]
              ? left
              : distances[1] <= distances[2]
                ? up
                : ul;
        const prediction = [0, left, up, Math.floor((left + up) / 2), paeth][y];
        raw[y * (stride + 1) + x + 1] = (values[at] - prediction) & 255;
      }
    }
    const decoded = decodePng(
      png(
        ihdr(width, height, channels === 4 ? 6 : 2),
        chunk('IDAT', deflateSync(raw)),
        chunk('IEND'),
      ),
    );
    for (let i = 0; i < width * height; i++)
      assert.deepEqual(
        [...decoded.data.subarray(i * 4, i * 4 + 4)],
        [
          ...values.subarray(i * channels, i * channels + 3),
          channels === 4 ? values[i * channels + 3] : 255,
        ],
      );
  }
  const key = Buffer.from([0, 20, 0, 30, 0, 40]);
  assert.deepEqual(
    pixel(
      decodePng(
        png(
          ihdr(1, 1, 2),
          chunk('tRNS', key),
          chunk('IDAT', deflateSync(Buffer.from([0, 20, 30, 40]))),
          chunk('IEND'),
        ),
      ),
      0,
      0,
    ),
    [20, 30, 40, 0],
  );
});

test('existing real alpha survives auto/alpha/chroma, even with maximum feather; no content recentring', () => {
  const source = image(5, 5, [11, 255, 22, 0]);
  put(source, 0, 3, [23, 169, 45, 137]);
  put(source, 1, 3, [200, 30, 40, 255]);
  const before = new Uint8Array(source.data);
  for (const background of ['auto', 'alpha', 'chroma'] as const) {
    const result = prepareFrame(source, { background, feather: 2 });
    assert.deepEqual(result.image.data, source.data);
    assert.deepEqual(result.qa.translation, { x: 0, y: 0 });
    assert.equal(result.qa.alphaMin, 0);
    assert.equal(result.qa.alphaMax, 255);
    assert.equal(result.qa.foregroundRatio, 2 / 25);
    assert.equal(result.qa.transparentRatio, 23 / 25);
    assert.equal(result.qa.edgeTouchPixels, 1);
    assert.equal(result.qa.empty, false);
  }
  assert.deepEqual(source.data, before, 'Source bytes remain intact');
  assert.deepEqual(
    prepareFrame(source, { background: 'auto', targetAnchor: { x: 0.5, y: 0.5 } }).image,
    source,
    'A pivot alone never guesses a source anchor',
  );
});

test('green screen creates a smooth matte and removes edge green spill without changing red/blue detail', () => {
  const source = image(7, 7, [0, 255, 0, 255]);
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) put(source, x, y, [230, 20, 40, 255]);
  put(source, 1, 3, [90, 200, 40, 255]);
  const { image: result, qa } = prepareFrame(source, { background: 'auto', feather: 0 });
  assert.deepEqual(pixel(result, 0, 0), [0, 0, 0, 0]);
  assert.deepEqual(pixel(result, 3, 3), [230, 20, 40, 255]);
  const edge = pixel(result, 1, 3);
  assert(edge[3] > 0 && edge[3] < 255);
  assert(edge[1] <= Math.max(edge[0], edge[2]));
  assert.equal(edge[0], 90);
  assert.equal(edge[2], 40);
  assert.equal(qa.alphaMin, 0);
  assert.equal(qa.alphaMax, 255);
  assert.equal(qa.edgeTouchPixels, 0);
  assert.equal(qa.empty, false);
  assert.equal(source.data[1], 255, 'Keying does not mutate the source');
});

test('normalized chroma keys dark/bright green identically and preserves white clothing, gray, black and dark blue hair', () => {
  const bright = image(7, 7, [0, 255, 0, 255]),
    dark = image(7, 7, [0, 155, 0, 255]);
  const foreground = [
    [255, 255, 255, 255],
    [120, 123, 121, 255],
    [0, 0, 0, 255],
    [2, 7, 3, 255],
    [6, 9, 31, 255],
  ];
  for (let i = 0; i < foreground.length; i++) {
    put(bright, i + 1, 3, foreground[i]);
    put(dark, i + 1, 3, foreground[i]);
  }
  assert.throws(
    () => prepareFrame(dark, { background: 'auto', feather: 0 }),
    /边界/,
    'Default RGB behavior is unchanged',
  );
  const a = prepareFrame(bright, { background: 'auto', keyMetric: 'chroma', feather: 0 }),
    b = prepareFrame(dark, { background: 'auto', keyMetric: 'chroma', feather: 0 });
  assert.deepEqual(a.image, b.image);
  assert.deepEqual(a.qa, b.qa);
  assert.deepEqual(pixel(b.image, 0, 0), [0, 0, 0, 0]);
  for (let i = 0; i < foreground.length; i++)
    assert.deepEqual(pixel(b.image, i + 1, 3), foreground[i]);
  // Even permissive key thresholds must not erase neutral foreground colors.
  const neutral = image(5, 5, [0, 155, 0, 255]);
  for (let i = 0; i < 4; i++) put(neutral, i, 2, foreground[i]);
  const guarded = prepareFrame(neutral, {
    background: 'chroma',
    keyMetric: 'chroma',
    similarity: 1,
    feather: 0,
  }).image;
  for (let i = 0; i < 4; i++) assert.deepEqual(pixel(guarded, i, 2), foreground[i]);
});

test('normalized chroma produces equal soft alpha across brightness-scaled green edges and removes green spill', () => {
  const bright = image(5, 5, [0, 255, 0, 255]),
    dark = image(5, 5, [0, 155, 0, 255]);
  put(bright, 2, 2, [40, 160, 20, 255]);
  put(dark, 2, 2, [20, 80, 10, 255]);
  const a = prepareFrame(bright, { background: 'chroma', keyMetric: 'chroma', feather: 0 }).image,
    b = prepareFrame(dark, { background: 'chroma', keyMetric: 'chroma', feather: 0 }).image;
  const edgeA = pixel(a, 2, 2),
    edgeB = pixel(b, 2, 2);
  assert(edgeA[3] > 0 && edgeA[3] < 255);
  assert.equal(edgeA[3], edgeB[3]);
  assert.deepEqual(edgeA.slice(0, 3), [40, 40, 20]);
  assert.deepEqual(edgeB.slice(0, 3), [20, 20, 10]);
  const existing = image(2, 2, [0, 155, 0, 91]);
  assert.deepEqual(
    prepareFrame(existing, { background: 'chroma', keyMetric: 'chroma', feather: 2 }).image,
    existing,
    'Real alpha remains untouched by the new metric',
  );
  assert.throws(
    () => prepareFrame(bright, { background: 'chroma', keyMetric: 'chroma', keyColor: '#000000' }),
    /非近黑/,
  );
});

test('feather acts only on generated alpha and never blurs RGB or adds an exact-key halo', () => {
  const source = image(7, 7, [0, 255, 0, 255]);
  for (let y = 2; y < 5; y++) for (let x = 2; x < 5; x++) put(source, x, y, [230, 20, 40, 255]);
  const sharp = prepareFrame(source, { background: 'chroma', feather: 0 }).image,
    feathered = prepareFrame(source, { background: 'chroma', feather: 1 }).image;
  for (let at = 0; at < source.data.length; at += 4)
    assert.deepEqual(
      [...feathered.data.subarray(at, at + 3)],
      [...sharp.data.subarray(at, at + 3)],
    );
  assert.equal(pixel(feathered, 0, 0)[3], 0);
  assert.equal(pixel(feathered, 3, 3)[3], 255);
  assert(pixel(feathered, 2, 3)[3] > 0 && pixel(feathered, 2, 3)[3] < 255);
});

test('opaque non-key auto is rejected, interior key is insufficient for auto, and empty mattes are reported honestly', () => {
  const opaque = image(5, 5, [230, 20, 40, 255]);
  assert.throws(() => prepareFrame(opaque, { background: 'auto' }), /边界/);
  assert.throws(() => prepareFrame(opaque, { background: 'chroma' }), /没有可确认/);
  assert(
    prepareFrame(opaque, { background: 'alpha' }).qa.warnings.some((v) => v.includes('不透明')),
  );
  put(opaque, 2, 2, [0, 255, 0, 255]);
  assert.throws(() => prepareFrame(opaque, { background: 'auto' }), /边界/);
  assert.equal(pixel(prepareFrame(opaque, { background: 'chroma', feather: 0 }).image, 2, 2)[3], 0);
  const empty = prepareFrame(image(5, 5, [0, 255, 0, 255]), { background: 'auto' });
  assert.equal(empty.qa.empty, true);
  assert.equal(empty.qa.foregroundRatio, 0);
  assert.equal(empty.qa.transparentRatio, 1);
  assert.equal(empty.qa.edgeTouchPixels, 0);
  assert.equal(empty.qa.alphaMax, 0);
});

test('explicit normalized anchors translate by integer canvas pixels and count clipped foreground, not transparent padding', () => {
  const source = image(5, 5);
  put(source, 0, 3, [230, 20, 40, 255]);
  const moved = prepareFrame(source, {
    background: 'alpha',
    anchor: { x: 0, y: 0.6 },
    targetAnchor: { x: 0.4, y: 0.2 },
  });
  assert.deepEqual(moved.qa.translation, { x: 2, y: -2 });
  assert.equal(moved.qa.clippedPixels, 0);
  assert.deepEqual(pixel(moved.image, 2, 1), [230, 20, 40, 255]);
  assert.equal(moved.image.width, 5);
  assert.equal(moved.image.height, 5);
  assert.deepEqual(
    prepareFrame(source, {
      background: 'alpha',
      anchor: { x: 0.5, y: 0.5 },
      targetAnchor: { x: 0.49, y: 0.49 },
    }).qa.translation,
    { x: 0, y: 0 },
  );
  const lost = prepareFrame(source, {
    background: 'alpha',
    anchor: { x: 1, y: 0 },
    targetAnchor: { x: 0, y: 0 },
  });
  assert.deepEqual(lost.qa.translation, { x: -5, y: 0 });
  assert.equal(lost.qa.clippedPixels, 1);
  assert.equal(lost.qa.empty, true);
  assert(lost.qa.warnings.some((v) => v.includes('裁掉')));
  const corner = prepareFrame(image(1, 1, [2, 3, 4, 255]), { background: 'alpha' });
  assert.equal(corner.qa.edgeTouchPixels, 1, 'Corner pixels are counted only once');
});

test('grid crop is row-major, accounts for margin and spacing, permits non-square cells and owns output buffers', () => {
  const source = image(9, 7);
  for (let y = 0; y < 7; y++) for (let x = 0; x < 9; x++) put(source, x, y, [x, y, 99, 255]);
  const frames = cropGrid(source, { columns: 2, rows: 2, count: 3, margin: 1, spacing: 1 });
  assert.equal(frames.length, 3);
  for (const f of frames) assert.deepEqual([f.width, f.height], [3, 2]);
  assert.deepEqual(pixel(frames[0], 0, 0), [1, 1, 99, 255]);
  assert.deepEqual(pixel(frames[1], 0, 0), [5, 1, 99, 255]);
  assert.deepEqual(pixel(frames[2], 2, 1), [3, 5, 99, 255]);
  frames[0].data[0] = 255;
  assert.equal(pixel(source, 1, 1)[0], 1);
  assert.throws(() => cropGrid(source, { columns: 2, rows: 2 }), /严格整除/);
  assert.throws(
    () => cropGrid(source, { columns: 2, rows: 2, count: 5, margin: 1, spacing: 1 }),
    /count/,
  );
  assert.throws(() => cropGrid(source, { columns: 2, rows: 2, count: 0 }), /count/);
  assert.throws(() => cropGrid(source, { columns: 0, rows: 2 }), /columns/);
  assert.throws(() => cropGrid(source, { columns: 2, rows: 2, spacing: -1 }), /spacing/);
  const tiny = image(100, 100);
  assert.throws(() => cropGrid(tiny, { columns: 100, rows: 100 }), /4096帧/);
  assert.equal(cropGrid(tiny, { columns: 100, rows: 100, count: 1 }).length, 1);
});

test('PNG rejects corrupt CRC, invalid dimensions/formats/chunks, truncation, filter errors and decompression bombs', () => {
  const corrupt = simplePng();
  corrupt[16] ^= 1;
  assert.throws(() => decodePng(corrupt), /CRC/);
  for (const h of [
    ihdr(0),
    ihdr(4097),
    ihdr(1, 4097),
    ihdr(1, 1, 6, 16),
    ihdr(1, 1, 3),
    ihdr(1, 1, 6, 8, 1),
  ])
    assert.throws(() => decodePng(simplePng(undefined, h)), /尺寸|只支持/);
  assert.throws(() => decodePng(simplePng(Buffer.from([5, 20, 30, 40, 255]))), /滤波/);
  assert.throws(() => decodePng(simplePng(Buffer.from([0, 20, 30]))), /解压长度/);
  assert.throws(() => decodePng(simplePng(Buffer.alloc(1024 * 1024))), /解压长度/);
  assert.throws(
    () =>
      decodePng(
        png(
          ihdr(),
          chunk(
            'IDAT',
            Buffer.concat([
              deflateSync(Buffer.from([0, 20, 30, 40, 255])),
              Buffer.from('trailing-zlib-bytes'),
            ]),
          ),
          chunk('IEND'),
        ),
      ),
    /解压长度/,
  );
  assert.throws(() => decodePng(simplePng().subarray(0, -3)), /截断|越界/);
  assert.throws(() => decodePng(Buffer.concat([simplePng(), Buffer.from([0])])), /尾随/);
  const badLength = Buffer.from(simplePng());
  badLength.writeUInt32BE(0xffffffff, 8);
  assert.throws(() => decodePng(badLength), /越界/);
  assert.throws(
    () =>
      decodePng(
        png(
          chunk(Buffer.from([0xc9, 72, 68, 82]), ihdr().subarray(8, -4)),
          chunk('IDAT', deflateSync(Buffer.alloc(5))),
          chunk('IEND'),
        ),
      ),
    /分块类型/,
  );
  const compressed = deflateSync(Buffer.alloc(5));
  assert.throws(
    () =>
      decodePng(
        png(
          ihdr(),
          chunk('IDAT', compressed.subarray(0, 2)),
          chunk('zzZz'),
          chunk('IDAT', compressed.subarray(2)),
          chunk('IEND'),
        ),
      ),
    /顺序/,
  );
  assert.throws(
    () =>
      decodePng(
        png(ihdr(), chunk('ZZZZ'), chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND')),
      ),
    /关键分块/,
  );
  assert.throws(
    () =>
      decodePng(
        png(ihdr(), chunk('acTL'), chunk('IDAT', deflateSync(Buffer.alloc(5))), chunk('IEND')),
      ),
    /动画/,
  );
  assert.throws(
    () =>
      decodePng(
        png(
          ihdr(),
          ...Array.from({ length: 4096 }, () => chunk('zzZz')),
          chunk('IDAT', deflateSync(Buffer.alloc(5))),
          chunk('IEND'),
        ),
      ),
    /分块数量/,
  );
  assert.throws(() => encodePng({ width: 4097, height: 1, data: new Uint8Array() }), /尺寸/);
  assert.throws(() => encodePng({ width: 1, height: 1, data: new Uint8Array(3) }), /长度/);
});

test('pixel options reject nonfinite/out-of-range inputs before processing', () => {
  const source = image(2, 2);
  for (const bad of [
    { similarity: NaN },
    { similarity: -1 },
    { blend: 2 },
    { feather: 3 },
    { keyColor: 'green' },
    { keyMetric: 'unknown' },
    { anchor: { x: 2, y: 0 } },
    { targetAnchor: { x: Infinity, y: 0 } },
    { similarity: null },
    { feather: null },
  ])
    assert.throws(() => prepareFrame(source, { background: 'alpha', ...bad } as any));
});

test('codec interoperates with actual local FFmpeg RGB/RGBA PNG and raw RGBA decoding', (t) => {
  const binary = [
    process.env.LIGHTMAO_FFMPEG_PATH,
    join(homedir(), '.local/pylibs/imageio_ffmpeg/binaries/ffmpeg-macos-aarch64-v7.1'),
    '/opt/homebrew/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
  ].find((v): v is string => !!v && existsSync(v));
  if (!binary) {
    t.skip('No installed FFmpeg; no download requested');
    return;
  }
  for (const format of ['rgb24', 'rgba']) {
    const bytes = execFileSync(
      binary,
      [
        '-nostdin',
        '-hide_banner',
        '-loglevel',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=c=red:s=4x4:d=0.04',
        '-frames:v',
        '1',
        '-pix_fmt',
        format,
        '-f',
        'image2pipe',
        '-c:v',
        'png',
        'pipe:1',
      ],
      { maxBuffer: 1024 * 1024 },
    );
    const decoded = decodePng(bytes);
    assert.deepEqual([decoded.width, decoded.height], [4, 4]);
    const p = pixel(decoded, 0, 0);
    assert(p[0] > 240 && p[1] < 5 && p[2] < 5);
    assert.equal(p[3], 255);
  }
  const source = image(3, 2, [31, 63, 127, 119]);
  put(source, 0, 0, [255, 0, 100, 0]);
  const raw = execFileSync(
    binary,
    [
      '-nostdin',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      'pipe:0',
      '-frames:v',
      '1',
      '-pix_fmt',
      'rgba',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    { input: encodePng(source), maxBuffer: 1024 * 1024 },
  );
  assert.deepEqual([...raw], [...source.data]);
});
