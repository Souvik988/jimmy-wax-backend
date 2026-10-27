import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve, sep } from 'node:path';
import sharp from 'sharp';

/** Object storage boundary. Local disk for dev/single-host; an S3-compatible adapter can implement the same interface. */
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

export class LocalDiskStorage implements ObjectStorage {
  private root: string;
  constructor(root: string) {
    this.root = resolve(root);
  }
  private path(key: string) {
    if (!/^[A-Za-z0-9/_.-]{1,200}$/.test(key) || key.includes('..')) throw new Error('invalid storage key');
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error('invalid storage key');
    return p;
  }
  async put(key: string, data: Buffer) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, data);
  }
  async get(key: string) {
    try {
      return await readFile(this.path(key));
    } catch {
      return null;
    }
  }
  async delete(key: string) {
    await rm(this.path(key), { force: true });
  }
}

export class InMemoryStorage implements ObjectStorage {
  readonly objects = new Map<string, Buffer>();
  async put(key: string, data: Buffer) {
    this.objects.set(key, data);
  }
  async get(key: string) {
    return this.objects.get(key) ?? null;
  }
  async delete(key: string) {
    this.objects.delete(key);
  }
}

// ------------------------------------------------------------ image intake
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_DIM = 6000;
export type ImageKind = 'image/jpeg' | 'image/png' | 'image/webp';

/** Detects the real type from magic bytes — the client-declared Content-Type is never trusted. */
export function sniffImage(b: Buffer): ImageKind | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 12 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (
    b.length > 12 &&
    b.subarray(0, 4).toString('ascii') === 'RIFF' &&
    b.subarray(8, 12).toString('ascii') === 'WEBP'
  )
    return 'image/webp';
  return null;
}

export class ImageRejected extends Error {}

/**
 * Validates and re-encodes an upload. Decoding + re-encoding to WebP strips EXIF/GPS and any embedded payload;
 * dimension and size limits bound decompression cost. Returns the sanitised derivative only.
 */
export async function sanitizeImage(
  input: Buffer,
): Promise<{ data: Buffer; mime: 'image/webp'; width: number; height: number; original: ImageKind }> {
  if (input.length === 0 || input.length > MAX_BYTES)
    throw new ImageRejected('Image must be between 1 byte and 5 MB');
  const kind = sniffImage(input);
  if (!kind) throw new ImageRejected('Only JPEG, PNG or WebP images are accepted');
  try {
    const meta = await sharp(input, { limitInputPixels: MAX_DIM * MAX_DIM, failOn: 'error' }).metadata();
    if (!meta.width || !meta.height || meta.width > MAX_DIM || meta.height > MAX_DIM)
      throw new ImageRejected('Image dimensions are too large');
    const out = await sharp(input, { limitInputPixels: MAX_DIM * MAX_DIM })
      .rotate() // honour EXIF orientation, then drop metadata
      .resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 82 })
      .toBuffer({ resolveWithObject: true });
    return {
      data: out.data,
      mime: 'image/webp',
      width: out.info.width,
      height: out.info.height,
      original: kind,
    };
  } catch (e) {
    if (e instanceof ImageRejected) throw e;
    throw new ImageRejected('This file is not a valid image');
  }
}
