import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalDiskStorage, type ObjectStorage } from './media.ts';

/**
 * S3-compatible object storage (AWS S3, Cloudflare R2, MinIO, DigitalOcean Spaces, ...) behind the same
 * ObjectStorage boundary the local-disk store implements. Keys stay content-addressed (`media/<sha256>/<file>`), so
 * objects are immutable: a re-upload of identical bytes overwrites with identical bytes and nothing is ever updated in place.
 *
 * Lifecycle (see docs/build/PRODUCTION_RUNBOOK.md): enable bucket VERSIONING and keep the bucket private - the API is the only
 * reader; configure a lifecycle rule that expires non-current versions after 30 days and aborts incomplete multipart uploads
 * after 7 days. Never put an expiry on the current version of `media/*`: published releases refer to those keys forever.
 */
export interface S3Like {
  send(command: unknown): Promise<unknown>;
}

export interface S3StorageOptions {
  bucket: string;
  /** Optional key prefix (for example `prod/`), so one bucket can serve several environments. */
  prefix?: string;
  client: S3Like;
}

const CONTENT_TYPE: Record<string, string> = {
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  txt: 'text/plain',
};

const KEY = /^[A-Za-z0-9/_.-]{1,200}$/;

export class S3Storage implements ObjectStorage {
  private prefix: string;
  constructor(private opts: S3StorageOptions) {
    this.prefix = (opts.prefix ?? '').replace(/^\/+/, '');
    if (this.prefix && !this.prefix.endsWith('/')) this.prefix += '/';
  }
  private key(key: string): string {
    if (!KEY.test(key) || key.includes('..') || key.startsWith('/')) throw new Error('invalid storage key');
    return this.prefix + key;
  }
  async put(key: string, data: Buffer): Promise<void> {
    const ext = key.split('.').pop() ?? '';
    await this.opts.client.send(
      new PutObjectCommand({
        Bucket: this.opts.bucket,
        Key: this.key(key),
        Body: data,
        ContentType: CONTENT_TYPE[ext] ?? 'application/octet-stream',
        CacheControl: key.startsWith('media/') ? 'public, max-age=31536000, immutable' : 'private, no-store',
      }),
    );
  }
  async get(key: string): Promise<Buffer | null> {
    try {
      const out = (await this.opts.client.send(
        new GetObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }),
      )) as {
        Body?: { transformToByteArray(): Promise<Uint8Array> };
      };
      if (!out.Body) return null;
      return Buffer.from(await out.Body.transformToByteArray());
    } catch (e) {
      const err = e as { name?: string; Code?: string; $metadata?: { httpStatusCode?: number } };
      if (err.name === 'NoSuchKey' || err.Code === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404)
        return null;
      throw e;
    }
  }
  async delete(key: string): Promise<void> {
    await this.opts.client.send(new DeleteObjectCommand({ Bucket: this.opts.bucket, Key: this.key(key) }));
  }
}

export interface StorageSettings {
  STORAGE_DRIVER: 'disk' | 's3';
  STORAGE_DIR: string;
  S3_BUCKET?: string | undefined;
  S3_REGION?: string | undefined;
  S3_ENDPOINT?: string | undefined;
  S3_ACCESS_KEY_ID?: string | undefined;
  S3_SECRET_ACCESS_KEY?: string | undefined;
  S3_FORCE_PATH_STYLE?: boolean | undefined;
  S3_PREFIX?: string | undefined;
}

/** The one place that turns configuration into an ObjectStorage, shared by the API, the experience API and the workers. */
export function createObjectStorage(c: StorageSettings): ObjectStorage {
  if (c.STORAGE_DRIVER === 's3') {
    const client = new S3Client({
      region: c.S3_REGION ?? 'auto',
      ...(c.S3_ENDPOINT ? { endpoint: c.S3_ENDPOINT } : {}),
      forcePathStyle: c.S3_FORCE_PATH_STYLE ?? false,
      ...(c.S3_ACCESS_KEY_ID && c.S3_SECRET_ACCESS_KEY
        ? { credentials: { accessKeyId: c.S3_ACCESS_KEY_ID, secretAccessKey: c.S3_SECRET_ACCESS_KEY } }
        : {}),
    });
    return new S3Storage({ bucket: c.S3_BUCKET!, ...(c.S3_PREFIX ? { prefix: c.S3_PREFIX } : {}), client });
  }
  return new LocalDiskStorage(c.STORAGE_DIR);
}
