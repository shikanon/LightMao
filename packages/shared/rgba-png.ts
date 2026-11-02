import { deflateSync, inflateSync } from 'node:zlib';

export type RgbaImage = { width: number; height: number; data: Uint8Array };
export const MAX_RGBA_DIMENSION = 4096;
const MAX_PNG_BYTES = 96 * 1024 * 1024;
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const crcTable = Uint32Array.from({ length: 256 }, (_, n) => {
  let crc = n;
  for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  return crc >>> 0;
});
function crc32(type: Uint8Array, data: Uint8Array) {
  let crc = 0xffffffff;
  for (const part of [type, data])
    for (const byte of part) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
function dimensions(width: number, height: number) {
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAX_RGBA_DIMENSION ||
    height > MAX_RGBA_DIMENSION
  )
    throw Error('PNG/RGBA尺寸必须为1..4096的整数');
}
export function validateRgbaImage(image: RgbaImage) {
  if (!image || typeof image !== 'object') throw Error('RGBA图像无效');
  dimensions(image.width, image.height);
  if (!(image.data instanceof Uint8Array) || image.data.length !== image.width * image.height * 4)
    throw Error('RGBA像素长度与画布尺寸不一致');
}
function writeChunk(target: Buffer, offset: number, name: string, data: Uint8Array) {
  const type = Buffer.from(name, 'ascii');
  target.writeUInt32BE(data.length, offset);
  target.set(type, offset + 4);
  target.set(data, offset + 8);
  target.writeUInt32BE(crc32(type, data), offset + 8 + data.length);
  return offset + 12 + data.length;
}
/** Lossless, non-interlaced 8-bit RGBA PNG. Pixel dimensions bound every allocation. */
export function encodePng(image: RgbaImage): Buffer {
  validateRgbaImage(image);
  const stride = image.width * 4,
    scanlines = Buffer.allocUnsafe((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) {
    const offset = y * (stride + 1);
    scanlines[offset] = 0;
    scanlines.set(image.data.subarray(y * stride, (y + 1) * stride), offset + 1);
  }
  const compressed = deflateSync(scanlines),
    header = Buffer.alloc(13);
  header.writeUInt32BE(image.width);
  header.writeUInt32BE(image.height, 4);
  header[8] = 8;
  header[9] = 6;
  const result = Buffer.allocUnsafe(8 + 25 + 12 + compressed.length + 12);
  result.set(PNG_SIGNATURE);
  let offset = writeChunk(result, 8, 'IHDR', header);
  offset = writeChunk(result, offset, 'IDAT', compressed);
  writeChunk(result, offset, 'IEND', Buffer.alloc(0));
  return result;
}
function paeth(a: number, b: number, c: number) {
  const p = a + b - c,
    da = Math.abs(p - a),
    db = Math.abs(p - b),
    dc = Math.abs(p - c);
  return da <= db && da <= dc ? a : db <= dc ? b : c;
}
/** Strict PNG decoder: RGB/RGBA, 8-bit, non-interlaced; all chunks retain CRC validation. */
export function decodePng(buffer: Buffer): RgbaImage {
  if (
    !Buffer.isBuffer(buffer) ||
    buffer.length < 8 ||
    buffer.length > MAX_PNG_BYTES ||
    !buffer.subarray(0, 8).equals(PNG_SIGNATURE)
  )
    throw Error('PNG签名或文件大小无效（最大96MiB）');
  let offset = 8,
    chunks = 0,
    width = 0,
    height = 0,
    channels = 0,
    ended = false,
    idatStarted = false,
    idatEnded = false,
    palette = false;
  const idats: Buffer[] = [];
  let compressedLength = 0,
    transparentColor: number[] | undefined;
  while (offset < buffer.length) {
    if (++chunks > 4096 || buffer.length - offset < 12) throw Error('PNG分块数量超限或分块被截断');
    const length = buffer.readUInt32BE(offset),
      end = offset + 12 + length;
    if (end > buffer.length) throw Error('PNG分块长度越界');
    const type = buffer.subarray(offset + 4, offset + 8),
      name = type.toString('ascii'),
      data = buffer.subarray(offset + 8, end - 4);
    if (!type.every((v) => (v >= 65 && v <= 90) || (v >= 97 && v <= 122)) || type[2] & 32)
      throw Error('PNG分块类型无效');
    if (crc32(type, data) !== buffer.readUInt32BE(end - 4))
      throw Error('PNG分块CRC校验失败：' + name);
    if (chunks === 1 && name !== 'IHDR') throw Error('PNG首块必须为IHDR');
    if (name === 'IHDR') {
      if (chunks !== 1 || length !== 13) throw Error('PNG IHDR重复或长度无效');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      dimensions(width, height);
      if (
        data[8] !== 8 ||
        ![2, 6].includes(data[9]) ||
        data[10] !== 0 ||
        data[11] !== 0 ||
        data[12] !== 0
      )
        throw Error('PNG只支持8bit RGB/RGBA、标准压缩、非隔行图像');
      channels = data[9] === 6 ? 4 : 3;
    } else if (name === 'IDAT') {
      if (!channels || idatEnded) throw Error('PNG IDAT顺序无效');
      idatStarted = true;
      compressedLength += data.length;
      if (compressedLength > MAX_PNG_BYTES) throw Error('PNG压缩数据超出大小限制');
      idats.push(data);
    } else {
      if (idatStarted) idatEnded = true;
      if (name === 'IEND') {
        if (length || !idatStarted || end !== buffer.length)
          throw Error('PNG IEND无效或存在尾随数据');
        ended = true;
        offset = end;
        break;
      }
      if (name === 'PLTE') {
        if (palette || idatStarted || !length || length % 3 || length > 768)
          throw Error('PNG PLTE无效');
        palette = true;
      } else if (name === 'tRNS') {
        if (channels !== 3 || idatStarted || transparentColor || length !== 6)
          throw Error('PNG tRNS无效');
        transparentColor = [data.readUInt16BE(0), data.readUInt16BE(2), data.readUInt16BE(4)];
        if (transparentColor.some((v) => v > 255)) throw Error('PNG tRNS颜色超出8bit范围');
      } else if (['acTL', 'fcTL', 'fdAT'].includes(name))
        throw Error('PNG动画不支持，请先解码为独立帧');
      else if (!(type[0] & 32)) throw Error('PNG存在不支持的关键分块：' + name);
    }
    offset = end;
  }
  if (!ended || !compressedLength || !channels) throw Error('PNG缺少完整的IHDR/IDAT/IEND');
  const stride = width * channels,
    expectedLength = (stride + 1) * height;
  const compressed = idats.length === 1 ? idats[0] : Buffer.concat(idats, compressedLength);
  let raw: Buffer;
  try {
    const inflated = inflateSync(compressed, {
      maxOutputLength: expectedLength,
      info: true,
    }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    raw = inflated.buffer;
    if (raw.length !== expectedLength || inflated.engine.bytesWritten !== compressed.length)
      throw Error('长度不匹配或压缩数据有尾随内容');
  } catch (error) {
    throw Error('PNG解压失败或解压长度与画布不一致', { cause: error });
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const start = y * (stride + 1),
      filter = raw[start];
    if (filter > 4) throw Error('PNG行滤波类型无效');
    for (let x = 0; x < stride; x++) {
      const current = start + 1 + x,
        left = x >= channels ? raw[current - channels] : 0,
        up = y ? raw[current - stride - 1] : 0,
        upperLeft = y && x >= channels ? raw[current - stride - 1 - channels] : 0;
      const predictor =
        filter === 0
          ? 0
          : filter === 1
            ? left
            : filter === 2
              ? up
              : filter === 3
                ? Math.floor((left + up) / 2)
                : paeth(left, up, upperLeft);
      raw[current] = (raw[current] + predictor) & 255;
    }
    for (let x = 0; x < width; x++) {
      const source = start + 1 + x * channels,
        target = (y * width + x) * 4;
      rgba[target] = raw[source];
      rgba[target + 1] = raw[source + 1];
      rgba[target + 2] = raw[source + 2];
      rgba[target + 3] =
        channels === 4
          ? raw[source + 3]
          : transparentColor && transparentColor.every((v, c) => v === raw[source + c])
            ? 0
            : 255;
    }
  }
  return { width, height, data: rgba };
}
