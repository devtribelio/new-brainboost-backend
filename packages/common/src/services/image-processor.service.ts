import sharp from 'sharp';
import { env } from '../config/env';
import { BadRequestException } from '../exceptions';

export interface ProcessedImage {
  buffer: Buffer;
  contentType: 'image/webp';
  ext: 'webp';
  width: number;
  height: number;
  size: number;
}

export interface ImageProcessOptions {
  maxDimension?: number;
  quality?: number;
}

/**
 * Validate + normalise an uploaded image:
 *   - rejects non-image input (sharp throws on undecodable buffers),
 *   - downscales so the longest side <= maxDimension (never upscales),
 *   - re-encodes to webp (drops EXIF/metadata by default → strips GPS etc.
 *     and neutralises polyglot payloads riding in the original container).
 */
export class ImageProcessor {
  async process(input: Buffer, opts: ImageProcessOptions = {}): Promise<ProcessedImage> {
    const maxDimension = opts.maxDimension ?? env.s3.imageMaxDimension;
    const quality = opts.quality ?? env.s3.imageWebpQuality;

    let pipeline: sharp.Sharp;
    let metadata: sharp.Metadata;
    try {
      // `failOn: 'error'` rejects truncated/corrupt images.
      pipeline = sharp(input, { failOn: 'error' });
      metadata = await pipeline.metadata();
    } catch {
      throw new BadRequestException('Uploaded file is not a valid image');
    }

    if (!metadata.format || !metadata.width || !metadata.height) {
      throw new BadRequestException('Uploaded file is not a valid image');
    }

    const out = await pipeline
      .rotate() // honour EXIF orientation before metadata is stripped
      .resize({
        width: maxDimension,
        height: maxDimension,
        fit: 'inside',
        withoutEnlargement: true,
      })
      .webp({ quality })
      .toBuffer({ resolveWithObject: true });

    return {
      buffer: out.data,
      contentType: 'image/webp',
      ext: 'webp',
      width: out.info.width,
      height: out.info.height,
      size: out.info.size,
    };
  }
}

export const imageProcessor = new ImageProcessor();
