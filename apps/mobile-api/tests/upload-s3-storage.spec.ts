import { describe, it, expect, beforeEach } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { S3Client, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { S3StorageService } from '@bb/common/services/s3-storage.service';

const s3Mock = mockClient(S3Client);

describe('S3StorageService', () => {
  beforeEach(() => {
    s3Mock.reset();
    s3Mock.on(PutObjectCommand).resolves({});
    s3Mock.on(DeleteObjectCommand).resolves({});
  });

  it('classifies keys by prefix', () => {
    const svc = new S3StorageService(new S3Client({ region: 'us-east-1' }), 'bkt');
    expect(svc.isPublicKey('public/uploads/u/a.webp')).toBe(true);
    expect(svc.isPublicKey('private/reports/r/a.pdf')).toBe(false);
  });

  it('putObject dispatches a PutObjectCommand with the key + content type', async () => {
    const svc = new S3StorageService(new S3Client({ region: 'us-east-1' }), 'bkt');
    await svc.putObject({ key: 'public/uploads/u/a.webp', body: Buffer.from('x'), contentType: 'image/webp' });

    const calls = s3Mock.commandCalls(PutObjectCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].input).toMatchObject({
      Bucket: 'bkt',
      Key: 'public/uploads/u/a.webp',
      ContentType: 'image/webp',
    });
  });

  it('getPublicUrl returns a URL ending with the object key', () => {
    const svc = new S3StorageService(new S3Client({ region: 'us-east-1' }), 'bkt');
    const url = svc.getPublicUrl('public/uploads/u/a.webp');
    expect(url.endsWith('public/uploads/u/a.webp')).toBe(true);
  });

  it('getPublicUrl refuses private keys', () => {
    const svc = new S3StorageService(new S3Client({ region: 'us-east-1' }), 'bkt');
    expect(() => svc.getPublicUrl('private/reports/r/a.pdf')).toThrow();
  });

  it('urlForKey signs private keys into an expiring presigned URL', async () => {
    // Real client with dummy creds — presigner signs offline, no network.
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'AKIATEST', secretAccessKey: 'secret' },
    });
    const svc = new S3StorageService(client, 'bkt');

    const url = await svc.urlForKey('private/reports/r/a.pdf', 120);
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Expires=120');
    expect(url).toContain('private/reports/r/a.pdf');
  });

  it('deleteObject dispatches a DeleteObjectCommand', async () => {
    const svc = new S3StorageService(new S3Client({ region: 'us-east-1' }), 'bkt');
    await svc.deleteObject('public/uploads/u/a.webp');
    expect(s3Mock.commandCalls(DeleteObjectCommand)).toHaveLength(1);
  });
});
