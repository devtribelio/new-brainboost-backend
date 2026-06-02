import { describe, it, expect, vi } from 'vitest';
import { UploadService } from '../src/modules/upload/upload.service';
import { BadRequestException } from '@bb/common/exceptions';

function fakeFile(over: Partial<Express.Multer.File> = {}): Express.Multer.File {
  return {
    fieldname: 'image',
    originalname: 'photo.png',
    encoding: '7bit',
    mimetype: 'image/png',
    size: 10,
    buffer: Buffer.from('rawbytes'),
    destination: '',
    filename: '',
    path: '',
    stream: undefined as never,
    ...over,
  };
}

function buildService() {
  const storage = {
    putObject: vi.fn().mockResolvedValue(undefined),
    getPublicUrl: vi.fn((key: string) => `https://cdn.test/${key}`),
  };
  const processor = {
    process: vi.fn().mockResolvedValue({
      buffer: Buffer.from('webp'),
      contentType: 'image/webp',
      ext: 'webp',
      width: 100,
      height: 100,
      size: 4,
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const svc = new UploadService(storage as any, processor as any);
  return { svc, storage, processor };
}

describe('UploadService.uploadImages', () => {
  it('writes to public/uploads/<owner>/ for the default kind', async () => {
    const { svc, storage } = buildService();
    const [item] = await svc.uploadImages([fakeFile()], 'owner-1');

    const key = storage.putObject.mock.calls[0][0].key as string;
    expect(key).toMatch(/^public\/uploads\/owner-1\/[0-9a-f-]+\.webp$/);
    expect(item.fileId).toBe(key);
    expect(item.fullUrl).toBe(`https://cdn.test/${key}`);
    expect(item.type).toBe('image/webp');
  });

  it('maps kind to its folder prefix', async () => {
    const { svc, storage } = buildService();
    await svc.uploadImages([fakeFile()], 'u9', 'avatar');
    expect(storage.putObject.mock.calls[0][0].key).toMatch(/^public\/avatars\/u9\//);

    await svc.uploadImages([fakeFile()], 'u9', 'post');
    expect(storage.putObject.mock.calls[1][0].key).toMatch(/^public\/posts\/u9\//);
  });

  it('passes the per-kind maxDimension to the image processor', async () => {
    const { svc, processor } = buildService();
    await svc.uploadImages([fakeFile()], 'u9', 'avatar');
    expect(processor.process.mock.calls[0][1]).toMatchObject({ maxDimension: 512 });

    await svc.uploadImages([fakeFile()], 'u9', 'post');
    expect(processor.process.mock.calls[1][1]).toMatchObject({ maxDimension: 1440 });

    await svc.uploadImages([fakeFile()], 'u9'); // default → general
    expect(processor.process.mock.calls[2][1]).toMatchObject({ maxDimension: 1024 });
  });

  it('rejects an empty file list', async () => {
    const { svc } = buildService();
    await expect(svc.uploadImages([], 'u1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects a non-image mimetype before processing', async () => {
    const { svc, processor } = buildService();
    await expect(
      svc.uploadImages([fakeFile({ mimetype: 'application/pdf', originalname: 'x.pdf' })], 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(processor.process).not.toHaveBeenCalled();
  });

  it('rejects a blocked executable extension', async () => {
    const { svc } = buildService();
    await expect(
      svc.uploadImages([fakeFile({ originalname: 'evil.php', mimetype: 'image/png' })], 'u1'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });
});
