import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ImageProcessor } from '@bb/common/services/image-processor.service';
import { BadRequestException } from '@bb/common/exceptions';

const processor = new ImageProcessor();

function isWebp(buf: Buffer): boolean {
  // RIFF....WEBP container signature.
  return buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP';
}

describe('ImageProcessor.process', () => {
  it('downscales an oversized image to fit maxDimension and re-encodes to webp', async () => {
    const input = await sharp({
      create: { width: 4000, height: 3000, channels: 3, background: { r: 10, g: 20, b: 30 } },
    })
      .png()
      .toBuffer();

    const out = await processor.process(input, { maxDimension: 2048 });

    expect(out.contentType).toBe('image/webp');
    expect(out.ext).toBe('webp');
    expect(isWebp(out.buffer)).toBe(true);
    // Longest side clamped to 2048, aspect ratio preserved (4000x3000 → 2048x1536).
    expect(Math.max(out.width, out.height)).toBeLessThanOrEqual(2048);
    expect(out.width).toBe(2048);
    expect(out.height).toBe(1536);
  });

  it('defaults the longest side to 1024 when no maxDimension is given', async () => {
    const input = await sharp({
      create: { width: 4000, height: 2000, channels: 3, background: { r: 1, g: 2, b: 3 } },
    })
      .png()
      .toBuffer();

    const out = await processor.process(input);

    expect(Math.max(out.width, out.height)).toBe(1024);
    expect(out.width).toBe(1024);
    expect(out.height).toBe(512);
  });

  it('does not upscale images smaller than maxDimension', async () => {
    const input = await sharp({
      create: { width: 320, height: 240, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .jpeg()
      .toBuffer();

    const out = await processor.process(input, { maxDimension: 2048 });

    expect(out.width).toBe(320);
    expect(out.height).toBe(240);
  });

  it('rejects a non-image buffer', async () => {
    await expect(processor.process(Buffer.from('this is definitely not an image'))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });
});
