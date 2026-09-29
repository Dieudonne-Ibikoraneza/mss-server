import { ConfigService } from '@nestjs/config';
import { Client } from 'minio';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

/** One private S3 bucket, with namespaces for the application's logical buckets. */
export class MinioStorage {
  private readonly client: Client;
  private readonly bucket: string;
  private bucketReady: Promise<void> | null = null;

  constructor(config: ConfigService) {
    this.bucket = config.getOrThrow<string>('storage.minio.bucket');
    this.client = new Client({
      endPoint: config.getOrThrow<string>('storage.minio.endpoint'),
      port: config.get<number>('storage.minio.port') ?? 9000,
      useSSL: config.get<boolean>('storage.minio.useSSL') ?? false,
      accessKey: config.getOrThrow<string>('storage.minio.accessKey'),
      secretKey: config.getOrThrow<string>('storage.minio.secretKey'),
      region: config.get<string>('storage.minio.region') ?? 'us-east-1',
    });
  }

  private objectKey(logicalBucket: string, path: string): string {
    if (
      !/^[A-Za-z][A-Za-z0-9]*$/.test(logicalBucket) ||
      !path ||
      path.startsWith('/') ||
      path.includes('\\') ||
      path.includes('\0') ||
      path.split('/').some((part) => part === '..' || part === '.')
    ) {
      throw new Error('Invalid storage object reference.');
    }
    return `${logicalBucket.toLowerCase()}/${path}`;
  }

  ensureBucket(): Promise<void> {
    this.bucketReady ??= this.createBucket().catch((error: unknown) => {
      this.bucketReady = null;
      throw error;
    });
    return this.bucketReady;
  }

  private async createBucket(): Promise<void> {
    if (await this.client.bucketExists(this.bucket)) return;
    try {
      await this.client.makeBucket(this.bucket);
    } catch (error) {
      if ((error as { code?: string }).code !== 'BucketAlreadyOwnedByYou') throw error;
    }
  }

  async upload(
    logicalBucket: string,
    path: string,
    buffer: Buffer,
    mimeType: string,
  ): Promise<void> {
    const key = this.objectKey(logicalBucket, path);
    await this.ensureBucket();
    await this.client.putObject(this.bucket, key, buffer, buffer.length, {
      'Content-Type': mimeType,
      'Cache-Control': 'private, max-age=3600',
    });
  }

  async download(logicalBucket: string, path: string): Promise<Blob> {
    const key = this.objectKey(logicalBucket, path);
    const stat = await this.client.statObject(this.bucket, key);
    if (stat.size > MAX_IMAGE_BYTES) throw new Error('Storage image exceeds the size limit.');
    const stream = await this.client.getObject(this.bucket, key);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
      size += buffer.length;
      if (size > MAX_IMAGE_BYTES) {
        stream.destroy();
        throw new Error('Storage image exceeds the size limit.');
      }
      chunks.push(buffer);
    }
    const contentType = stat.metaData['content-type'] as string | undefined;
    return new Blob([new Uint8Array(Buffer.concat(chunks))], {
      type: contentType ?? 'application/octet-stream',
    });
  }
}
