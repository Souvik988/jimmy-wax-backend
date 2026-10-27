import { createHash } from 'node:crypto';
import sharp from 'sharp';

/**
 * Media-library intake. The declared Content-Type is never trusted: the real type comes from magic bytes.
 * Images are decoded and re-encoded (EXIF/GPS and embedded payloads are dropped) into content-addressed WebP variants.
 * Video and fonts are validated by container signature and size and stored as-is: this service does NOT transcode or
 * probe video (no ffmpeg worker yet), so video width/height/duration stay null until one exists.
 */
export type LibraryKind = 'image' | 'video' | 'font';
export class MediaRejected extends Error {}

export interface LibraryLimits {
  maxImageBytes: number;
  maxVideoBytes: number;
  maxFontBytes: number;
}
export const DEFAULT_LIMITS: LibraryLimits = {
  maxImageBytes: 15 * 1024 * 1024,
  maxVideoBytes: 100 * 1024 * 1024,
  maxFontBytes: 2 * 1024 * 1024,
};

const MAX_PIXELS = 8000 * 8000;
const ORIG_MAX_DIM = 4000;
const VARIANT_WIDTHS = [320, 640, 1080, 1600] as const;

export interface StoredFile {
  file: string;
  data: Buffer;
  mime: string;
  width?: number;
}
export interface Processed {
  kind: LibraryKind;
  sha256: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  files: StoredFile[];
  /** Metadata persisted on the asset row (no buffers). */
  variants: Array<{ file: string; width: number | null; bytes: number; mime: string }>;
}

export function sniff(b: Buffer): { kind: LibraryKind; mime: string; ext: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff)
    return { kind: 'image', mime: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return { kind: 'image', mime: 'image/png', ext: 'png' };
  if (b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP')
    return { kind: 'image', mime: 'image/webp', ext: 'webp' };
  if (b.subarray(4, 8).toString('ascii') === 'ftyp') return { kind: 'video', mime: 'video/mp4', ext: 'mp4' };
  if (b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3)
    return { kind: 'video', mime: 'video/webm', ext: 'webm' };
  const tag = b.subarray(0, 4).toString('ascii');
  if (tag === 'wOF2') return { kind: 'font', mime: 'font/woff2', ext: 'woff2' };
  if (tag === 'OTTO') return { kind: 'font', mime: 'font/otf', ext: 'otf' };
  if (b.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0])) || tag === 'true')
    return { kind: 'font', mime: 'font/ttf', ext: 'ttf' };
  return null;
}

export const sha256Hex = (b: Buffer) => createHash('sha256').update(b).digest('hex');

export async function processLibraryMedia(
  input: Buffer,
  limits: LibraryLimits = DEFAULT_LIMITS,
): Promise<Processed> {
  if (input.length === 0) throw new MediaRejected('The file is empty');
  const t = sniff(input);
  if (!t)
    throw new MediaRejected('Unsupported file type. Use JPEG, PNG, WebP, MP4, WebM, WOFF2, TTF or OTF.');
  const cap = { image: limits.maxImageBytes, video: limits.maxVideoBytes, font: limits.maxFontBytes }[t.kind];
  if (input.length > cap)
    throw new MediaRejected(`${t.kind} files may be at most ${Math.floor(cap / 1048576)} MB`);
  const sha256 = sha256Hex(input);

  if (t.kind !== 'image') {
    const file = `${t.kind === 'video' ? 'video' : 'font'}.${t.ext}`;
    return {
      kind: t.kind,
      sha256,
      mime: t.mime,
      bytes: input.length,
      width: null,
      height: null,
      files: [{ file, data: input, mime: t.mime }],
      variants: [{ file, width: null, bytes: input.length, mime: t.mime }],
    };
  }

  try {
    const meta = await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'error' }).metadata();
    if (!meta.width || !meta.height) throw new MediaRejected('This file is not a valid image');
    const base = sharp(input, { limitInputPixels: MAX_PIXELS }).rotate(); // honour EXIF orientation, then drop metadata
    const orig = await base
      .clone()
      .resize({ width: ORIG_MAX_DIM, height: ORIG_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: 85 })
      .toBuffer({ resolveWithObject: true });
    const files: StoredFile[] = [
      { file: 'orig.webp', data: orig.data, mime: 'image/webp', width: orig.info.width },
    ];
    for (const w of VARIANT_WIDTHS) {
      if (w >= orig.info.width) continue; // never upscale
      const v = await base
        .clone()
        .resize({ width: w, withoutEnlargement: true })
        .webp({ quality: 80 })
        .toBuffer({ resolveWithObject: true });
      files.push({ file: `w${w}.webp`, data: v.data, mime: 'image/webp', width: v.info.width });
    }
    return {
      kind: 'image',
      sha256,
      mime: 'image/webp',
      bytes: input.length,
      width: orig.info.width,
      height: orig.info.height,
      files,
      variants: files.map((f) => ({
        file: f.file,
        width: f.width ?? null,
        bytes: f.data.length,
        mime: f.mime,
      })),
    };
  } catch (e) {
    if (e instanceof MediaRejected) throw e;
    throw new MediaRejected('This file is not a valid image');
  }
}

/** Allowed public file names inside a content-addressed media folder. */
export const MEDIA_FILE = /^(orig\.webp|w\d{3,4}\.webp|video\.(mp4|webm)|font\.(woff2|ttf|otf))$/;
export const mediaKey = (sha256: string, file: string) => `media/${sha256}/${file}`;
export const MIME_BY_EXT: Record<string, string> = {
  webp: 'image/webp',
  mp4: 'video/mp4',
  webm: 'video/webm',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
};
