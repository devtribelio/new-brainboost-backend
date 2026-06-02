import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { env } from '../config/env';

/**
 * Visibility is derived from the object key prefix, NOT per-object ACLs:
 *   - `public/*`  → served directly from the CDN / S3 public base URL.
 *     Public read is granted by a bucket policy on the `public/*` prefix
 *     (infra, not code) so this works even with ACLs disabled
 *     ("Bucket owner enforced").
 *   - `private/*` → no public access; reads go through a short-lived
 *     presigned GET URL minted per request.
 */
export const PUBLIC_PREFIX = 'public/';
export const PRIVATE_PREFIX = 'private/';

export interface PutObjectInput {
  key: string;
  body: Buffer | Uint8Array;
  contentType: string;
}

function buildClient(): S3Client {
  return new S3Client({
    region: env.s3.region,
    // Empty endpoint → AWS default resolution. Set for MinIO / R2.
    ...(env.s3.endpoint ? { endpoint: env.s3.endpoint } : {}),
    forcePathStyle: env.s3.forcePathStyle,
    ...(env.s3.accessKeyId && env.s3.secretAccessKey
      ? {
          credentials: {
            accessKeyId: env.s3.accessKeyId,
            secretAccessKey: env.s3.secretAccessKey,
          },
        }
      : {}),
  });
}

export class S3StorageService {
  private readonly client: S3Client;
  private readonly bucket: string;

  /** `client` injectable for tests (e.g. aws-sdk-client-mock). */
  constructor(client?: S3Client, bucket: string = env.s3.bucket) {
    this.client = client ?? buildClient();
    this.bucket = bucket;
  }

  isPublicKey(key: string): boolean {
    return key.startsWith(PUBLIC_PREFIX);
  }

  /** Upload bytes under `key`. ContentType is required so the CDN serves it correctly. */
  async putObject({ key, body, contentType }: PutObjectInput): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      }),
    );
  }

  /** Permanent CDN/public URL for a `public/*` object. Throws for private keys. */
  getPublicUrl(key: string): string {
    if (!this.isPublicKey(key)) {
      throw new Error(`getPublicUrl called on non-public key: ${key}`);
    }
    const base = (env.s3.publicBaseUrl || env.s3.endpoint || '').replace(/\/$/, '');
    if (!base) {
      // No CDN configured — fall back to a path-style URL against the bucket.
      return `/${this.bucket}/${key}`;
    }
    return `${base}/${key}`;
  }

  /** Short-lived signed GET URL for a `private/*` object. */
  async getPresignedGetUrl(key: string, expiresIn: number = env.s3.presignExpires): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      { expiresIn },
    );
  }

  /**
   * Resolve a key to a fetchable URL: permanent public URL for `public/*`,
   * presigned URL for everything else.
   */
  async urlForKey(key: string, expiresIn?: number): Promise<string> {
    return this.isPublicKey(key) ? this.getPublicUrl(key) : this.getPresignedGetUrl(key, expiresIn);
  }

  async deleteObject(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }
}

/** Shared singleton for app wiring; tests construct their own with a mock client. */
export const s3StorageService = new S3StorageService();
