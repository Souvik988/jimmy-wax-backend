import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it } from 'vitest';
import { S3Storage, createObjectStorage } from '../../src/s3.ts';
import { LocalDiskStorage } from '../../src/media.ts';

/** In-memory stand-in for the S3 wire protocol: records commands and answers like S3 (NoSuchKey for missing keys). */
function fakeS3() {
  const objects = new Map<string, { body: Buffer; type?: string; cache?: string }>();
  const log: unknown[] = [];
  return {
    objects,
    log,
    async send(cmd: unknown) {
      log.push(cmd);
      if (cmd instanceof PutObjectCommand) {
        const i = cmd.input;
        objects.set(`${i.Bucket}/${i.Key}`, {
          body: Buffer.from(i.Body as Buffer),
          type: i.ContentType,
          cache: i.CacheControl,
        });
        return {};
      }
      if (cmd instanceof GetObjectCommand) {
        const o = objects.get(`${cmd.input.Bucket}/${cmd.input.Key}`);
        if (!o)
          throw Object.assign(new Error('The specified key does not exist.'), {
            name: 'NoSuchKey',
            $metadata: { httpStatusCode: 404 },
          });
        return { Body: { transformToByteArray: async () => new Uint8Array(o.body) } };
      }
      if (cmd instanceof DeleteObjectCommand) {
        objects.delete(`${cmd.input.Bucket}/${cmd.input.Key}`);
        return {};
      }
      throw new Error('unexpected command');
    },
  };
}

describe('S3Storage', () => {
  it('stores content-addressed media under the prefix with immutable caching and the right content type', async () => {
    const s3 = fakeS3();
    const st = new S3Storage({ bucket: 'b', prefix: '/prod', client: s3 });
    const sha = 'a'.repeat(64);
    await st.put(`media/${sha}/orig.webp`, Buffer.from('img'));
    const stored = s3.objects.get(`b/prod/media/${sha}/orig.webp`);
    expect(stored).toMatchObject({ type: 'image/webp', cache: 'public, max-age=31536000, immutable' });
    expect((await st.get(`media/${sha}/orig.webp`))?.toString()).toBe('img');
    await st.put('labels/x.pdf', Buffer.from('pdf'));
    expect(s3.objects.get('b/prod/labels/x.pdf')).toMatchObject({
      type: 'application/pdf',
      cache: 'private, no-store',
    });
  });

  it('returns null for a missing key, rethrows other failures and deletes', async () => {
    const s3 = fakeS3();
    const st = new S3Storage({ bucket: 'b', client: s3 });
    expect(await st.get('media/nothing/orig.webp')).toBeNull();
    const broken = new S3Storage({
      bucket: 'b',
      client: {
        send: async () => {
          throw Object.assign(new Error('boom'), {
            name: 'InternalError',
            $metadata: { httpStatusCode: 500 },
          });
        },
      },
    });
    await expect(broken.get('media/x/orig.webp')).rejects.toThrow('boom');
    await st.put('media/k/orig.webp', Buffer.from('1'));
    await st.delete('media/k/orig.webp');
    expect(await st.get('media/k/orig.webp')).toBeNull();
  });

  it('refuses keys that could escape the prefix', async () => {
    const st = new S3Storage({ bucket: 'b', prefix: 'prod', client: fakeS3() });
    for (const bad of ['../x', 'media/../../x', '/abs', 'a b', 'a'.repeat(201), ''])
      await expect(st.put(bad, Buffer.from('x'))).rejects.toThrow('invalid storage key');
  });

  it('createObjectStorage picks the driver', () => {
    expect(createObjectStorage({ STORAGE_DRIVER: 'disk', STORAGE_DIR: './.data/x' })).toBeInstanceOf(
      LocalDiskStorage,
    );
    expect(
      createObjectStorage({
        STORAGE_DRIVER: 's3',
        STORAGE_DIR: '.',
        S3_BUCKET: 'bucket',
        S3_REGION: 'ap-south-1',
        S3_ACCESS_KEY_ID: 'k',
        S3_SECRET_ACCESS_KEY: 's',
      }),
    ).toBeInstanceOf(S3Storage);
  });
});
