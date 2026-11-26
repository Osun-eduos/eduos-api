import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

/**
 * Where uploaded files (inspection photos) live. In production: any S3-compatible store (Cloudflare R2, Backblaze B2,
 * AWS S3), set with S3_BUCKET and its keys. Without a bucket, files are kept in the database, which suits development
 * and tests but makes backups large.
 */
@Injectable()
export class StorageService {
  private readonly log = new Logger('StorageService');
  private readonly s3: S3Client | null;
  private readonly bucket: string | null;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('S3_BUCKET');
    const driver = config.get<string>('STORAGE_DRIVER') ?? (bucket ? 's3' : 'db');
    if (driver === 's3' && bucket) {
      this.bucket = bucket;
      this.s3 = new S3Client({
        region: config.get<string>('S3_REGION') || 'auto',
        endpoint: config.get<string>('S3_ENDPOINT') || undefined,
        forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE') === 'true',
        credentials: { accessKeyId: config.get<string>('S3_ACCESS_KEY_ID') ?? '', secretAccessKey: config.get<string>('S3_SECRET_ACCESS_KEY') ?? '' },
      });
    } else {
      if (config.get('NODE_ENV') === 'production') this.log.warn('S3_BUCKET is not set: inspection photos are stored in the database.');
      this.bucket = null;
      this.s3 = null;
    }
  }

  get driver() {
    return this.s3 ? 's3' : 'db';
  }

  /** Saves a file. Returns the storage key, or "db" when the caller should keep the bytes itself. */
  async put(key: string, body: Buffer, contentType: string): Promise<string> {
    if (!this.s3) return 'db';
    await this.s3.send(new PutObjectCommand({ Bucket: this.bucket!, Key: key, Body: body, ContentType: contentType, CacheControl: 'private, max-age=31536000, immutable' }));
    return key;
  }

  async get(key: string): Promise<Buffer> {
    if (!this.s3) throw new Error('No object storage is set up.');
    const r = await this.s3.send(new GetObjectCommand({ Bucket: this.bucket!, Key: key }));
    return Buffer.from(await r.Body!.transformToByteArray());
  }
}
