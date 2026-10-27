import { createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from '@jw/database';
import { AppError } from '@jw/contracts';

export type CartOwner = { userId: string } | { guestToken: string };

export interface CartLineDto {
  variantId: string;
  productId: string;
  name: string;
  variantTitle: string;
  unitPricePaise: number;
  quantity: number;
  available: number;
  purchasable: boolean;
}
export interface CartDto {
  id: string;
  version: number;
  currency: 'INR';
  lines: CartLineDto[];
  subtotalPaise: number;
  couponCode: string | null;
}

export const hashGuestToken = (t: string) => createHash('sha256').update(t).digest('hex');
export const newGuestToken = () => randomBytes(32).toString('base64url');

/** Finds (or creates) the cart row and locks it, serialising every cart mutation and checkout. */
export async function lockCart(
  c: PoolClient,
  owner: CartOwner,
  create = true,
): Promise<{ id: string; version: number } | null> {
  const where =
    'userId' in owner ? ['user_id', owner.userId] : ['guest_token_hash', hashGuestToken(owner.guestToken)];
  let r = await c.query(`SELECT id, version FROM carts WHERE ${where[0]} = $1 FOR UPDATE`, [where[1]]);
  if (r.rowCount === 0) {
    if (!create) return null;
    if (!('userId' in owner)) throw new AppError('NOT_FOUND', 'Cart not found');
    r = await c.query(
      `INSERT INTO carts (user_id) VALUES ($1) ON CONFLICT (user_id) DO UPDATE SET user_id = excluded.user_id
       RETURNING id, version`,
      [owner.userId],
    );
  }
  return r.rows[0] as { id: string; version: number };
}

export async function readCart(c: PoolClient, cartId: string, version: number): Promise<CartDto> {
  const r = await c.query(
    `SELECT l.variant_id, l.quantity, v.product_id, v.title AS variant_title, v.price_paise, v.active AS v_active,
            p.name, p.active AS p_active, coalesce(i.on_hand - i.reserved, 0) AS available
       FROM cart_lines l
       JOIN product_variants v ON v.id = l.variant_id
       JOIN products p ON p.id = v.product_id
       LEFT JOIN inventory_positions i ON i.variant_id = l.variant_id
      WHERE l.cart_id = $1 ORDER BY l.created_at, l.variant_id`,
    [cartId],
  );
  const lines: CartLineDto[] = r.rows.map((x) => ({
    variantId: x.variant_id,
    productId: x.product_id,
    name: x.name,
    variantTitle: x.variant_title,
    unitPricePaise: x.price_paise,
    quantity: x.quantity,
    available: Number(x.available),
    purchasable: x.v_active && x.p_active && Number(x.available) >= x.quantity,
  }));
  return {
    id: cartId,
    version,
    currency: 'INR',
    lines,
    subtotalPaise: lines.reduce((s, l) => s + l.unitPricePaise * l.quantity, 0),
    couponCode:
      ((await c.query(`SELECT coupon_code FROM carts WHERE id = $1`, [cartId])).rows[0]?.coupon_code as
        string | null) ?? null,
  };
}

export async function getCart(c: PoolClient, owner: CartOwner): Promise<CartDto> {
  const row = await lockCart(c, owner, 'userId' in owner);
  if (!row) throw new AppError('NOT_FOUND', 'Cart not found');
  return readCart(c, row.id, row.version);
}

/** Sets a line's quantity (0 removes). Optimistic concurrency via expectedVersion. */
export async function setLine(
  c: PoolClient,
  owner: CartOwner,
  variantId: string,
  quantity: number,
  expectedVersion?: number,
): Promise<CartDto> {
  const cart = await lockCart(c, owner);
  if (!cart) throw new AppError('NOT_FOUND', 'Cart not found');
  if (expectedVersion !== undefined && expectedVersion !== cart.version) {
    throw new AppError('CART_VERSION_CONFLICT', 'The cart changed; reload it and try again');
  }
  if (quantity === 0) {
    await c.query(`DELETE FROM cart_lines WHERE cart_id = $1 AND variant_id = $2`, [cart.id, variantId]);
  } else {
    const v = await c.query(
      `SELECT 1 FROM product_variants v JOIN products p ON p.id = v.product_id WHERE v.id = $1 AND v.active AND p.active`,
      [variantId],
    );
    if (v.rowCount === 0)
      throw new AppError('ITEM_UNAVAILABLE', 'This item is not available', { lines: [{ variantId }] });
    await c.query(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity) VALUES ($1, $2, $3)
       ON CONFLICT (cart_id, variant_id) DO UPDATE SET quantity = excluded.quantity, updated_at = now()`,
      [cart.id, variantId, quantity],
    );
  }
  const bumped = await c.query(
    `UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
    [cart.id],
  );
  return readCart(c, cart.id, bumped.rows[0].version);
}

/**
 * Merge policy (documented in CONTRACT_DECISIONS.md): per variant, quantity = min(99, user + guest).
 * Guest cart is deleted after a successful merge. Requires a verified user AND the guest secret.
 */
export async function mergeGuestCart(c: PoolClient, userId: string, guestToken: string): Promise<CartDto> {
  // Lock order: guest first, then user (both merges take the same order → no deadlock).
  const guest = await lockCart(c, { guestToken }, false);
  const user = await lockCart(c, { userId });
  if (!user) throw new AppError('INTERNAL', 'cart missing');
  if (guest) {
    await c.query(
      `INSERT INTO cart_lines (cart_id, variant_id, quantity)
       SELECT $1, g.variant_id, least(99, g.quantity)
         FROM cart_lines g JOIN product_variants v ON v.id = g.variant_id AND v.active
        WHERE g.cart_id = $2
       ON CONFLICT (cart_id, variant_id) DO UPDATE
         SET quantity = least(99, cart_lines.quantity + excluded.quantity), updated_at = now()`,
      [user.id, guest.id],
    );
    await c.query(`DELETE FROM carts WHERE id = $1`, [guest.id]);
    const bumped = await c.query(
      `UPDATE carts SET version = version + 1, updated_at = now() WHERE id = $1 RETURNING version`,
      [user.id],
    );
    return readCart(c, user.id, bumped.rows[0].version);
  }
  return readCart(c, user.id, user.version);
}

export async function createGuestCart(c: PoolClient): Promise<{ token: string; cart: CartDto }> {
  const token = newGuestToken();
  const r = await c.query(
    `INSERT INTO carts (guest_token_hash, expires_at) VALUES ($1, now() + interval '30 days') RETURNING id, version`,
    [hashGuestToken(token)],
  );
  return { token, cart: await readCart(c, r.rows[0].id, r.rows[0].version) };
}
