import { validateRgbaImage, type RgbaImage } from '../../packages/shared/rgba-png.ts';
export { encodePng, decodePng, type RgbaImage } from '../../packages/shared/rgba-png.ts';

export type NormalizedAnchor = { x: number; y: number };
export interface PrepareFrameOptions {
  background: 'auto' | 'alpha' | 'chroma';
  keyColor?: string;
  keyMetric?: 'rgb' | 'chroma';
  similarity?: number;
  blend?: number;
  feather?: number;
  anchor?: NormalizedAnchor;
  targetAnchor?: NormalizedAnchor;
}
export interface FrameQa {
  alphaMin: number;
  alphaMax: number;
  transparentRatio: number;
  foregroundRatio: number;
  edgeTouchPixels: number;
  empty: boolean;
  clippedPixels: number;
  translation: { x: number; y: number };
  warnings: string[];
}
function bounded(value: number, label: string, min: number, max: number) {
  if (!Number.isFinite(value) || value < min || value > max)
    throw Error(`${label}必须在${min}..${max}范围内`);
  return value;
}
function anchor(value: NormalizedAnchor | undefined, label: string) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object') throw Error(label + '必须是归一化坐标');
  bounded(value.x, label + '.x', 0, 1);
  bounded(value.y, label + '.y', 0, 1);
}
const smooth = (v: number) => {
  const t = Math.max(0, Math.min(1, v));
  return t * t * (3 - 2 * t);
};
// Chromaticity near zero is unstable, and neutral clothing must not become key
// material merely because its brightness differs from the screen's brightness.
function protectedChroma(r: number, g: number, b: number) {
  const maximum = Math.max(r, g, b);
  return maximum < 16 || maximum - Math.min(r, g, b) <= maximum * 0.12;
}
/** Blur only a newly generated matte, never RGB or an input alpha channel. */
function featherMatte(matte: Uint8Array, width: number, height: number, feather: number) {
  if (!feather) return;
  const radius = Math.ceil(feather),
    weights = radius === 1 ? [1, 2, 1] : [1, 4, 6, 4, 1],
    divisor = radius === 1 ? 4 : 16,
    strength = feather / radius,
    horizontal = new Uint16Array(matte.length);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum += weights[k + radius] * matte[y * width + Math.max(0, Math.min(width - 1, x + k))];
      horizontal[y * width + x] = sum;
    }
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const at = y * width + x,
        original = matte[at];
      if (!original) continue; // Never add a visible halo to an exact-key background.
      let sum = 0;
      for (let k = -radius; k <= radius; k++)
        sum +=
          weights[k + radius] * horizontal[Math.max(0, Math.min(height - 1, y + k)) * width + x];
      matte[at] = Math.min(
        original,
        Math.round(original * (1 - strength) + (sum / (divisor * divisor)) * strength),
      );
    }
}
/** Same-canvas matte cleanup and explicit anchor translation. Does not recenter, scale or rotate. */
export function prepareFrame(
  source: RgbaImage,
  options: PrepareFrameOptions,
): { image: RgbaImage; qa: FrameQa } {
  validateRgbaImage(source);
  if (!options || !['auto', 'alpha', 'chroma'].includes(options.background))
    throw Error('background必须为auto、alpha或chroma');
  const similarity = bounded(
      options.similarity === undefined ? 0.18 : options.similarity,
      'similarity',
      0,
      1,
    ),
    blend = bounded(options.blend === undefined ? 0.12 : options.blend, 'blend', 0, 1),
    feather = bounded(options.feather === undefined ? 0.5 : options.feather, 'feather', 0, 2),
    keyColor = options.keyColor === undefined ? '#00ff00' : options.keyColor,
    keyMetric = options.keyMetric === undefined ? 'rgb' : options.keyMetric;
  if (typeof keyColor !== 'string' || !/^#[\da-f]{6}$/i.test(keyColor))
    throw Error('keyColor必须为#RRGGBB');
  if (!['rgb', 'chroma'].includes(keyMetric)) throw Error('keyMetric必须为rgb或chroma');
  anchor(options.anchor, 'anchor');
  anchor(options.targetAnchor, 'targetAnchor');
  const { width, height } = source,
    pixels = width * height,
    warnings: string[] = [];
  let data = new Uint8Array(source.data),
    hasAlpha = false;
  for (let at = 3; at < data.length; at += 4)
    if (data[at] < 255) {
      hasAlpha = true;
      break;
    }
  if (hasAlpha || options.background === 'alpha') {
    if (!hasAlpha) warnings.push('alpha模式输入完全不透明，未执行抠色。');
    if (hasAlpha && options.background === 'chroma')
      warnings.push('输入已有真实透明度，保留原RGBA；未进行二次抠色或羽化。');
  } else {
    const key = [1, 3, 5].map((at) => Number.parseInt(keyColor.slice(at, at + 2), 16)),
      keyTotal = key[0] + key[1] + key[2],
      keyChroma = key.map((v) => v / keyTotal),
      matte = new Uint8Array(pixels);
    if (keyMetric === 'chroma' && protectedChroma(key[0], key[1], key[2]))
      throw Error('chroma度量需要非近黑、非中性的keyColor，不能对灰阶色幕归一化抠色');
    let nearKey = 0,
      boundaryNearKey = 0;
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * width + x,
          at = p * 4,
          r = data[at],
          g = data[at + 1],
          b = data[at + 2],
          total = r + g + b,
          distance =
            keyMetric === 'rgb'
              ? Math.hypot(r - key[0], g - key[1], b - key[2]) / (255 * Math.sqrt(3))
              : protectedChroma(r, g, b)
                ? Number.POSITIVE_INFINITY
                : Math.hypot(
                    r / total - keyChroma[0],
                    g / total - keyChroma[1],
                    b / total - keyChroma[2],
                  ) / Math.SQRT2;
        if (distance <= similarity) {
          nearKey++;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) boundaryNearKey++;
        }
        matte[p] = Math.round(
          255 * (blend ? smooth((distance - similarity) / blend) : distance > similarity ? 1 : 0),
        );
      }
    if (!nearKey || (options.background === 'auto' && !boundaryNearKey))
      throw Error(
        options.background === 'auto'
          ? '不透明图像边界没有接近keyColor的背景，不能自动抠图；请提供真实alpha或明确的色幕。'
          : '不透明图像没有可确认的keyColor背景，未生成伪透明素材。',
      );
    featherMatte(matte, width, height, feather);
    const dominant = key.indexOf(Math.max(...key)),
      other = [0, 1, 2].filter((v) => v !== dominant),
      distinctKey = key[dominant] > Math.max(key[other[0]], key[other[1]]);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const p = y * width + x,
          at = p * 4,
          alpha = matte[p];
        data[at + 3] = alpha;
        if (!alpha) {
          data[at] = data[at + 1] = data[at + 2] = 0;
          continue;
        }
        const edge =
          alpha < 255 ||
          (x > 0 && matte[p - 1] < 255) ||
          (x + 1 < width && matte[p + 1] < 255) ||
          (y > 0 && matte[p - width] < 255) ||
          (y + 1 < height && matte[p + width] < 255);
        if (
          distinctKey &&
          edge &&
          !(keyMetric === 'chroma' && protectedChroma(data[at], data[at + 1], data[at + 2]))
        ) {
          const spill = data[at + dominant] - Math.max(data[at + other[0]], data[at + other[1]]);
          if (spill > 0) data[at + dominant] -= spill;
        }
      }
  }
  const translation =
    options.anchor && options.targetAnchor
      ? {
          x: Math.round((options.targetAnchor.x - options.anchor.x) * width) || 0,
          y: Math.round((options.targetAnchor.y - options.anchor.y) * height) || 0,
        }
      : { x: 0, y: 0 };
  let clippedPixels = 0;
  if (translation.x || translation.y) {
    const translated = new Uint8Array(data.length);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const at = (y * width + x) * 4,
          tx = x + translation.x,
          ty = y + translation.y;
        if (tx < 0 || tx >= width || ty < 0 || ty >= height) {
          if (data[at + 3]) clippedPixels++;
          continue;
        }
        translated.set(data.subarray(at, at + 4), (ty * width + tx) * 4);
      }
    data = translated;
  }
  let alphaMin = 255,
    alphaMax = 0,
    transparent = 0,
    edgeTouchPixels = 0;
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const alpha = data[(y * width + x) * 4 + 3];
      alphaMin = Math.min(alphaMin, alpha);
      alphaMax = Math.max(alphaMax, alpha);
      if (!alpha) transparent++;
      else if (x === 0 || y === 0 || x === width - 1 || y === height - 1) edgeTouchPixels++;
    }
  if (!alphaMax) warnings.push('图像没有可见前景。');
  if (clippedPixels) warnings.push(`锚点位移裁掉了${clippedPixels}个非透明源像素。`);
  if (edgeTouchPixels)
    warnings.push(`有${edgeTouchPixels}个前景像素接触画布边界，请检查是否裁边。`);
  return {
    image: { width, height, data },
    qa: {
      alphaMin,
      alphaMax,
      transparentRatio: transparent / pixels,
      foregroundRatio: (pixels - transparent) / pixels,
      edgeTouchPixels,
      empty: !alphaMax,
      clippedPixels,
      translation,
      warnings,
    },
  };
}
export interface GridOptions {
  columns: number;
  rows: number;
  count?: number;
  margin?: number;
  spacing?: number;
}
export function cropGrid(source: RgbaImage, options: GridOptions): RgbaImage[] {
  validateRgbaImage(source);
  if (!options) throw Error('网格参数缺失');
  const { columns, rows } = options,
    margin = options.margin === undefined ? 0 : options.margin,
    spacing = options.spacing === undefined ? 0 : options.spacing;
  for (const [label, value, min] of [
    ['columns', columns, 1],
    ['rows', rows, 1],
    ['margin', margin, 0],
    ['spacing', spacing, 0],
  ] as const)
    if (!Number.isInteger(value) || value < min || value > 4096)
      throw Error(`${label}必须为${min}..4096的整数`);
  const count = options.count === undefined ? columns * rows : options.count;
  if (!Number.isInteger(count) || count < 1 || count > columns * rows || count > 4096)
    throw Error('网格count必须为1..网格数，且单次最多输出4096帧');
  const usableWidth = source.width - 2 * margin - (columns - 1) * spacing,
    usableHeight = source.height - 2 * margin - (rows - 1) * spacing;
  if (usableWidth < columns || usableHeight < rows || usableWidth % columns || usableHeight % rows)
    throw Error('网格去除margin/spacing后的宽高必须严格整除columns/rows，且每格至少1像素');
  const width = usableWidth / columns,
    height = usableHeight / rows,
    frames: RgbaImage[] = [];
  for (let i = 0; i < count; i++) {
    const left = margin + (i % columns) * (width + spacing),
      top = margin + Math.floor(i / columns) * (height + spacing),
      data = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      const start = ((top + y) * source.width + left) * 4;
      data.set(source.data.subarray(start, start + width * 4), y * width * 4);
    }
    frames.push({ width, height, data });
  }
  return frames;
}
