import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';
import { Readable } from 'node:stream';
import { MinioStorage } from './minio-storage';
import { validationSchema } from '@/config/validation.schema';

jest.mock('minio', () => ({ Client: jest.fn() }));

describe('MinIO storage', () => {
  const client = {
    bucketExists: jest.fn(),
    makeBucket: jest.fn(),
    putObject: jest.fn(),
    statObject: jest.fn(),
    getObject: jest.fn(),
  };
  const createStorage = () =>
    new MinioStorage(
      new ConfigService({
        storage: {
          minio: {
            endpoint: 'magnificat-minio',
            port: 9000,
            useSSL: false,
            accessKey: 'test-access',
            secretKey: 'test-secret',
            bucket: 'magnificat-smart-space',
          },
        },
      }),
    );

  beforeEach(() => {
    jest.resetAllMocks();
    jest.mocked(Client).mockImplementation(() => client as unknown as Client);
    client.bucketExists.mockResolvedValue(false);
    client.makeBucket.mockResolvedValue(undefined);
    client.putObject.mockResolvedValue(undefined);
  });

  it('uses the configured endpoint and keeps logical buckets separate in one S3 bucket', async () => {
    const storage = createStorage();
    const image = Buffer.from('image');
    await Promise.all([
      storage.upload('Products', 'products/a.webp', image, 'image/webp'),
      storage.upload('RoomPhotos', 'rooms/user/a.webp', image, 'image/webp'),
    ]);
    expect(Client).toHaveBeenCalledWith(
      expect.objectContaining({ endPoint: 'magnificat-minio', port: 9000, useSSL: false }),
    );
    expect(client.makeBucket).toHaveBeenCalledTimes(1);
    expect(client.putObject).toHaveBeenCalledWith(
      'magnificat-smart-space',
      'products/products/a.webp',
      image,
      image.length,
      expect.objectContaining({ 'Content-Type': 'image/webp' }),
    );
    expect(client.putObject).toHaveBeenCalledWith(
      'magnificat-smart-space',
      'roomphotos/rooms/user/a.webp',
      image,
      image.length,
      expect.any(Object),
    );
  });

  it('does not recreate existing buckets', async () => {
    client.bucketExists.mockResolvedValue(true);
    await createStorage().ensureBucket();
    expect(client.makeBucket).not.toHaveBeenCalled();
  });

  it('retries a failed bucket check and tolerates concurrent creation by this account', async () => {
    const storage = createStorage();
    client.bucketExists.mockRejectedValueOnce(new Error('Connection refused'));
    await expect(storage.ensureBucket()).rejects.toThrow('Connection refused');
    client.makeBucket.mockRejectedValueOnce({ code: 'BucketAlreadyOwnedByYou' });
    await expect(storage.ensureBucket()).resolves.toBeUndefined();
    expect(client.bucketExists).toHaveBeenCalledTimes(2);
  });

  it('preserves downloaded bytes and their content type', async () => {
    client.statObject.mockResolvedValue({ size: 4, metaData: { 'content-type': 'image/png' } });
    client.getObject.mockResolvedValue(Readable.from([Buffer.from('im'), Buffer.from('ag')]));
    const blob = await createStorage().download('Collections', 'collections/a.png');
    expect(blob.type).toBe('image/png');
    expect(Buffer.from(await blob.arrayBuffer()).toString()).toBe('imag');
    expect(client.getObject).toHaveBeenCalledWith(
      'magnificat-smart-space',
      'collections/collections/a.png',
    );
  });

  it('rejects oversized objects before opening their streams', async () => {
    client.statObject.mockResolvedValue({ size: 21 * 1024 * 1024, metaData: {} });
    await expect(createStorage().download('Products', 'products/a.webp')).rejects.toThrow(
      'size limit',
    );
    expect(client.getObject).not.toHaveBeenCalled();
  });

  it.each(['/absolute.webp', '../outside.webp', 'products/../outside.webp', 'products\\bad.webp'])(
    'rejects invalid object references: %s',
    async (path) => {
      await expect(
        createStorage().upload('Products', path, Buffer.from(''), 'image/webp'),
      ).rejects.toThrow('Invalid storage object reference');
      expect(client.putObject).not.toHaveBeenCalled();
    },
  );

  it('requires MinIO credentials only when the MinIO driver is selected', () => {
    const base = {
      DATABASE_URL: 'postgresql://user:password@postgres:5432/db',
      JWT_ACCESS_SECRET: 'test-access-secret-123',
      JWT_REFRESH_SECRET: 'test-refresh-secret-123',
    };
    expect(validationSchema.validate(base).error).toBeUndefined();
    expect(validationSchema.validate({ ...base, STORAGE_DRIVER: 'minio' }).error).toBeDefined();
    const minio = {
      ...base,
      STORAGE_DRIVER: 'minio',
      MINIO_ACCESS_KEY: 'test-access',
      MINIO_SECRET_KEY: 'test-secret',
    };
    expect(validationSchema.validate(minio).error).toBeUndefined();
    expect(validationSchema.validate({ ...minio, MINIO_API_PORT: 0 }).error).toBeDefined();
    expect(validationSchema.validate({ ...minio, MINIO_BUCKET: 'Products' }).error).toBeDefined();
  });
});
