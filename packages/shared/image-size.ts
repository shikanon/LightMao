import { z } from 'zod';

// Seedream 5 Pro image-generation limits; explicit geometry makes equal-cell sheets predictable.
export const imageSize = z.string().refine((size) => {
  if (size === '1K' || size === '2K') return true;
  const match = size.match(/^([1-9]\d{2,3})x([1-9]\d{2,3})$/);
  if (!match) return false;
  const width = Number(match[1]),
    height = Number(match[2]),
    pixels = width * height;
  return (
    width <= 4096 &&
    height <= 4096 &&
    pixels >= 921600 &&
    pixels <= 4624220 &&
    width / height >= 1 / 16 &&
    width / height <= 16
  );
}, 'size需为1K/2K或明确宽x高，总像素921600~4624220、单边≤4096');
