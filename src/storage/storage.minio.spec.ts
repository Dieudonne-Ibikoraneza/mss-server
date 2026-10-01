import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { StorageService, ROOM_PHOTOS_BUCKET, COLLECTION_IMAGES_BUCKET } from './storage.service';
import { MinioStorage } from './minio-storage';

jest.mock('./minio-storage');

describe('StorageService with private MinIO objects', () => {
  const minio = { upload: jest.fn(), download: jest.fn(), ensureBucket: jest.fn() };
  const image = Buffer.from('GIF89a');
  const file = { buffer: image, mimetype: 'image/gif' } as Express.Multer.File;
  let storage: StorageService;

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(MinioStorage).mockImplementation(() => minio as unknown as MinioStorage);
    minio.upload.mockResolvedValue(undefined);
    minio.ensureBucket.mockResolvedValue(undefined);
    minio.download.mockResolvedValue(new Blob([image], { type: 'image/gif' }));
    storage = new StorageService(
      new ConfigService({
        storage: { driver: 'minio' },
        app: { clientUrl: 'https://app.example.com' },
        jwt: { accessSecret: 'test-access-secret-123' },
      }),
    );
  });

  const token = (url: string) => new URL(url).pathname.split('/').at(-1)!;

  it('uploads products and downloads the original bytes through an opaque application URL', async () => {
    const uploaded = await storage.uploadProductImage(file);
    expect(uploaded.path).toMatch(/^products\/.+\.gif$/);
    expect(uploaded.url).toMatch(/^https:\/\/app\.example\.com\/api\/product-images\//);
    expect(uploaded.url).not.toContain(uploaded.path);
    expect(storage.productImageSource(uploaded.url)).toBe(uploaded.path);
    const blob = await storage.getProductImageBlob(token(uploaded.url));
    expect(blob.type).toBe('image/gif');
    expect(Buffer.from(await blob.arrayBuffer())).toEqual(image);
    expect(minio.download).toHaveBeenCalledWith('Products', uploaded.path);
  });

  it.each([ROOM_PHOTOS_BUCKET, COLLECTION_IMAGES_BUCKET])(
    'proxies non-product images from the correct namespace: %s',
    async (bucket) => {
      const url = await storage.getSignedUrl('images/a.gif', bucket);
      expect(url).toMatch(/^https:\/\/app\.example\.com\/api\/product-images\//);
      await storage.getProductImageBlob(token(url));
      expect(minio.download).toHaveBeenCalledWith(bucket, 'images/a.gif');
    },
  );

  it('expires private non-product tokens and never sends an expired token to MinIO', async () => {
    jest.useFakeTimers();
    try {
      const url = await storage.getSignedUrl('rooms/user/a.gif', ROOM_PHOTOS_BUCKET);
      jest.advanceTimersByTime(3600_001);
      await expect(storage.getProductImageBlob(token(url))).rejects.toThrow('Image not found');
      expect(minio.download).not.toHaveBeenCalled();
      expect(await storage.getSignedUrl('rooms/user/a.gif', ROOM_PHOTOS_BUCKET)).not.toBe(url);
    } finally {
      jest.useRealTimers();
    }
  });

  it('rejects tampered tokens before contacting storage', async () => {
    const url = await storage.getSignedUrl('images/a.gif', ROOM_PHOTOS_BUCKET);
    const original = token(url);
    const tampered = (original.startsWith('A') ? 'B' : 'A') + original.slice(1);
    await expect(storage.getProductImageBlob(tampered)).rejects.toThrow('Image not found');
    expect(minio.download).not.toHaveBeenCalled();
  });

  it('reads room-photo bytes directly for the image model', async () => {
    const downloaded = await storage.downloadImage('rooms/user/a.gif', ROOM_PHOTOS_BUCKET);
    expect(downloaded).toEqual({ data: image.toString('base64'), mimeType: 'image/gif' });
    expect(minio.download).toHaveBeenCalledWith(ROOM_PHOTOS_BUCKET, 'rooms/user/a.gif');
  });

  it('reports unavailable MinIO uploads with the existing localized error', async () => {
    minio.upload.mockRejectedValueOnce(new Error('Connection refused'));
    const log = jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    try {
      await expect(storage.uploadRoomPhoto(file, 'test-user')).rejects.toMatchObject({
        response: { code: 'storage.uploadFailed' },
      });
    } finally {
      log.mockRestore();
    }
  });
});
