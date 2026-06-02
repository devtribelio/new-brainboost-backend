import { randomUUID } from 'node:crypto';
import { extname } from 'node:path';
import { BadRequestException } from '@bb/common/exceptions';
import {
  S3StorageService,
  s3StorageService,
  PUBLIC_PREFIX,
} from '@bb/common/services/s3-storage.service';
import { ImageProcessor, imageProcessor } from '@bb/common/services/image-processor.service';

// Defence-in-depth: even though we re-encode every image through sharp (which
// already neutralises non-image payloads), reject obviously executable
// extensions up front so a malformed multipart never reaches the processor.
const BLOCKED_EXTENSIONS = new Set([
  '.exe', '.bat', '.cmd', '.com', '.cpl', '.dll', '.scr', '.msi', '.msp', '.mst',
  '.vbs', '.vbe', '.wsf', '.wsh', '.ps1', '.psm1', '.psd1', '.ps1xml', '.psc1',
  '.psc2', '.jse', '.js', '.jar', '.sh', '.bash', '.zsh', '.fish', '.csh',
  '.tcsh', '.ksh', '.ade', '.adp', '.app', '.application', '.appref-ms', '.asp',
  '.aspx', '.cer', '.chm', '.crt', '.diagcab', '.fxp', '.gadget', '.hlp',
  '.hpj', '.hta', '.htc', '.inf', '.ins', '.isp', '.its', '.lnk', '.mad', '.maf',
  '.mag', '.mam', '.maq', '.mar', '.mas', '.mat', '.mau', '.mav', '.maw',
  '.mcf', '.mda', '.mdb', '.mde', '.mdt', '.mdw', '.mdz', '.php', '.php3', '.php4',
  '.php5', '.phtml', '.pl', '.py', '.pyc', '.pyo', '.rb',
]);

export interface UploadKindConfig {
  /** Folder under `public/`. */
  folder: string;
  /** Max longest-side (px) after resize for this kind. */
  maxDimension: number;
  /** webp quality 1-100. Omit → falls back to env `S3_IMAGE_WEBP_QUALITY`. */
  quality?: number;
}

/**
 * Upload kinds map to a `public/<folder>/` prefix + per-kind image sizing.
 * Avatars/logos are small (display thumbnails); posts/covers stay large.
 * Owner id is always the uploading member (at upload time the post/comment id
 * does not exist yet — the 2-step flow uploads first, then references the URL).
 */
export const UPLOAD_KINDS = {
  avatar: { folder: 'avatars', maxDimension: 512 },
  cover: { folder: 'covers', maxDimension: 1280 },
  post: { folder: 'posts', maxDimension: 1440 },
  comment: { folder: 'comments', maxDimension: 1024 },
  network: { folder: 'networks', maxDimension: 512 },
  general: { folder: 'uploads', maxDimension: 1024 },
} as const satisfies Record<string, UploadKindConfig>;

export type UploadKind = keyof typeof UPLOAD_KINDS;
export const UPLOAD_KIND_VALUES = Object.keys(UPLOAD_KINDS) as UploadKind[];
export const DEFAULT_UPLOAD_KIND: UploadKind = 'general';

export interface UploadedItem {
  filename: string;
  size: number;
  /** Object key — the durable identifier other endpoints persist. */
  fileId: string;
  status: 'success';
  message: 'OK';
  /** Object key (same as fileId); kept for FE wire compatibility. */
  url: string;
  /** Public CDN URL the FE stores and renders directly. */
  fullUrl: string;
  type: string;
}

export class UploadService {
  constructor(
    private readonly storage: S3StorageService = s3StorageService,
    private readonly processor: ImageProcessor = imageProcessor,
  ) {}

  /**
   * Process + upload one or more images to `public/<kind-folder>/<ownerId>/`.
   * Every file is re-encoded to webp before it touches S3.
   */
  async uploadImages(
    files: Express.Multer.File[],
    ownerId: string,
    kind: UploadKind = DEFAULT_UPLOAD_KIND,
  ): Promise<UploadedItem[]> {
    if (!files || files.length === 0) {
      throw new BadRequestException('No files received in field "image"');
    }

    const cfg: UploadKindConfig = UPLOAD_KINDS[kind];
    const results: UploadedItem[] = [];
    for (const f of files) {
      const ext = extname(f.originalname).toLowerCase();
      if (BLOCKED_EXTENSIONS.has(ext)) {
        throw new BadRequestException(`File extension "${ext}" is not allowed`);
      }
      if (!f.mimetype?.startsWith('image/')) {
        throw new BadRequestException(`Only image uploads are allowed (got "${f.mimetype}")`);
      }

      const processed = await this.processor.process(f.buffer, {
        maxDimension: cfg.maxDimension,
        quality: cfg.quality,
      });
      const key = `${PUBLIC_PREFIX}${cfg.folder}/${ownerId}/${randomUUID()}.${processed.ext}`;

      await this.storage.putObject({
        key,
        body: processed.buffer,
        contentType: processed.contentType,
      });

      results.push({
        filename: f.originalname,
        size: processed.size,
        fileId: key,
        status: 'success',
        message: 'OK',
        url: key,
        fullUrl: this.storage.getPublicUrl(key),
        type: processed.contentType,
      });
    }

    return results;
  }
}
