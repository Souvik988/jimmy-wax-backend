import { randomUUID } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';
import type { ObjectStorage } from '@jw/integrations';
import { audit, type AdminRole } from './admin.ts';

interface Ctx {
  adminId: string;
  role: AdminRole;
  requestId?: string;
}

export const MAX_MEDIA_PER_REVIEW = 3;

/** Only customers who received the product may review it (verified purchase). */
export async function createReview(
  c: PoolClient,
  userId: string,
  productId: string,
  input: { rating: number; title: string; body: string },
) {
  const bought = await c.query(
    `SELECT 1 FROM orders o JOIN order_items i ON i.order_id = o.id
      WHERE o.user_id = $1 AND i.product_id = $2 AND o.status = 'delivered' LIMIT 1`,
    [userId, productId],
  );
  if (bought.rowCount === 0) {
    throw new AppError('ILLEGAL_STATE', 'You can review a product after it has been delivered to you');
  }
  try {
    const r = await c.query(
      `INSERT INTO reviews (product_id, user_id, rating, title, body, status, verified_purchase)
       VALUES ($1,$2,$3,$4,$5,'pending',true) RETURNING id, status, created_at`,
      [productId, userId, input.rating, input.title.trim(), input.body.trim()],
    );
    return { id: r.rows[0].id as string, status: 'pending' as const, moderation: 'Awaiting moderation' };
  } catch (e) {
    if ((e as { code?: string }).code === '23505')
      throw new AppError('ILLEGAL_STATE', 'You have already reviewed this product');
    throw e;
  }
}

/** Stores the SANITISED derivative privately (quarantine). Only owner/moderators can see it until approval. */
export async function attachReviewMedia(
  c: PoolClient,
  storage: ObjectStorage,
  userId: string,
  reviewId: string,
  img: { data: Buffer; mime: 'image/webp'; width: number; height: number },
) {
  const rv = (
    await c.query(`SELECT id, status FROM reviews WHERE id = $1 AND user_id = $2 FOR UPDATE`, [
      reviewId,
      userId,
    ])
  ).rows[0];
  if (!rv) throw new AppError('NOT_FOUND', 'Review not found');
  const count = (
    await c.query(`SELECT count(*)::int AS n FROM review_media WHERE review_id = $1`, [reviewId])
  ).rows[0].n;
  if (count >= MAX_MEDIA_PER_REVIEW)
    throw new AppError('VALIDATION_FAILED', `At most ${MAX_MEDIA_PER_REVIEW} photos per review`);
  const id = randomUUID();
  const key = `review-private/${reviewId}/${id}.webp`;
  await storage.put(key, img.data);
  await c.query(
    `INSERT INTO review_media (id, review_id, original_key, mime, bytes, width, height) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [id, reviewId, key, img.mime, img.data.length, img.width, img.height],
  );
  return { id, status: 'pending' as const };
}

export async function moderateReview(
  c: PoolClient,
  x: Ctx,
  reviewId: string,
  approve: boolean,
  note: string,
) {
  const r = (await c.query(`SELECT * FROM reviews WHERE id = $1 FOR UPDATE`, [reviewId])).rows[0];
  if (!r) throw new AppError('NOT_FOUND', 'Review not found');
  await c.query(
    `UPDATE reviews SET status = $2, moderated_by = $3, moderation_note = $4, updated_at = now() WHERE id = $1`,
    [reviewId, approve ? 'approved' : 'rejected', x.adminId, note],
  );
  if (!approve)
    await c.query(`UPDATE review_media SET status = 'rejected' WHERE review_id = $1 AND status = 'pending'`, [
      reviewId,
    ]);
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: approve ? 'review.approve' : 'review.reject',
    resourceType: 'review',
    resourceId: reviewId,
    reason: note,
    requestId: x.requestId,
  });
}

/** Publishing copies the private derivative to the public key; rejecting leaves nothing public. */
export async function moderateMedia(
  c: PoolClient,
  storage: ObjectStorage,
  x: Ctx,
  mediaId: string,
  approve: boolean,
) {
  const m = (await c.query(`SELECT * FROM review_media WHERE id = $1 FOR UPDATE`, [mediaId])).rows[0];
  if (!m) throw new AppError('NOT_FOUND', 'Photo not found');
  if (m.status !== 'pending') throw new AppError('ILLEGAL_STATE', 'This photo was already moderated');
  if (approve) {
    const data = await storage.get(m.original_key);
    if (!data) throw new AppError('INTERNAL', 'The stored photo is missing');
    const pub = `review-public/${mediaId}.webp`;
    await storage.put(pub, data);
    await c.query(`UPDATE review_media SET status = 'approved', public_key = $2 WHERE id = $1`, [
      mediaId,
      pub,
    ]);
  } else {
    await storage.delete(m.original_key);
    await c.query(`UPDATE review_media SET status = 'rejected' WHERE id = $1`, [mediaId]);
  }
  await audit(c, {
    actorId: x.adminId,
    actorRole: x.role,
    action: approve ? 'review_media.approve' : 'review_media.reject',
    resourceType: 'review_media',
    resourceId: mediaId,
    requestId: x.requestId,
  });
}
