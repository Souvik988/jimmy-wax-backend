/**
 * Image / video slot requirements for Studio media props (DASH-BR image-slot request).
 *
 * Sizes are pixels of the SOURCE file. They are the minimum for a sharp result on a 3x phone (app) or a
 * 1920 px desktop viewport (web); a smaller file still publishes but the validator warns. `aspect` is the
 * shape the slot is cropped to (the client uses `focal` to choose the crop centre); `kind` says whether a still
 * image or a video is expected. The numbers are PROPOSED defaults - the owner/designer may tighten them here
 * and in one place only: this table feeds blocks.schema.json (`x-slot`) and the publish validator.
 */
export interface Slot {
  minWidth: number;
  minHeight?: number;
  /** "w:h" - the displayed crop. Blocks with an `aspectRatio` prop override it at render time. */
  aspect?: string;
  kind?: 'image' | 'video';
}

const img = (minWidth: number, minHeight: number | undefined, aspect: string): Slot => ({
  minWidth,
  ...(minHeight ? { minHeight } : {}),
  aspect,
});
const vid = (minWidth: number, minHeight: number, aspect: string): Slot => ({
  minWidth,
  minHeight,
  aspect,
  kind: 'video',
});

/** Keyed `<block type>:<prop path>`; `[]` marks an array item. */
export const BLOCK_SLOTS: Record<string, Slot> = {
  'app.hero_carousel:slides[].image': img(1170, 780, '3:2'),
  'app.category_shortcuts:items[].icon': img(240, 240, '1:1'),
  'app.benefits_row:items[].image': img(240, 240, '1:1'),
  'app.testimonials:heroImage': img(1080, 720, '3:2'),
  'app.promo_cards:cards[].image': img(1080, 608, '16:9'),
  'app.banner:image': img(1080, 608, '16:9'),

  'web.hero_film:film.desktop': vid(1920, 1080, '16:9'),
  'web.hero_film:film.mobile': vid(1080, 1920, '9:16'),
  'web.hero_film:film.poster': img(1920, 1080, '16:9'),
  'web.ritual_steps:steps[].image': img(1200, 900, '4:3'),
  'web.scrub_film:film': vid(1920, 1080, '16:9'),
  'web.scrub_film:poster': img(1920, 1080, '16:9'),
  'web.media_split:media': img(1200, 900, '4:3'),
  'web.media_split:poster': img(1200, 900, '4:3'),
  'web.standards_grid:items[].image': img(1200, 900, '4:3'),
  'web.evidence_rail:items[].image': img(800, 1000, '4:5'),
  'web.atelier_film:film': vid(1920, 1080, '16:9'),
  'web.atelier_film:poster': img(1920, 1080, '16:9'),
  'web.journal_stack:finale.image': img(1600, 1000, '8:5'),
  'web.promo_film:video': vid(1920, 1080, '16:9'),
  'web.promo_film:poster': img(1920, 1080, '16:9'),
  'web.closing_cta:media': img(1920, 1080, '16:9'),
  'web.image:image': img(1600, undefined, '16:9'),
};

/** Page-level SEO share image (both channels). */
export const SEO_OG_SLOT: Slot = img(1200, 630, '1.91:1');

/** Brand slots in the chrome document. */
export const BRAND_SLOT_SPECS: Record<string, Slot> = {
  'mascot.welcome': img(800, 800, '1:1'),
  'mascot.otp': img(800, 800, '1:1'),
  'mascot.signed_in': img(800, 800, '1:1'),
  'mascot.order_placed': img(800, 800, '1:1'),
  'mascot.empty_cart': img(800, 800, '1:1'),
  'mascot.empty_orders': img(800, 800, '1:1'),
  'mascot.cheer': img(800, 800, '1:1'),
  'state.empty_cart': img(800, 800, '1:1'),
  'state.empty_wishlist': img(800, 800, '1:1'),
  'state.no_orders': img(800, 800, '1:1'),
  'state.generic_error': img(800, 800, '1:1'),
  'state.no_connection': img(800, 800, '1:1'),
  'state.tracking_pending': img(800, 800, '1:1'),
  'backdrop.surface': img(1170, 2532, '9:19.5'),
  'backdrop.order_success': img(1170, 2532, '9:19.5'),
  'splash.scene': img(1170, 2532, '9:19.5'),
  'category.all_banner': img(1080, 540, '2:1'),
  'category.browse_hero': img(1080, 720, '3:2'),
  'category.empty': img(600, 600, '1:1'),
  'logo.wordmark': img(600, undefined, 'free'),
  'logo.mark': img(512, 512, '1:1'),
  favicon: img(512, 512, '1:1'),
  'og.default': img(1200, 630, '1.91:1'),
};

export function slotFor(blockType: string, path: string): Slot | undefined {
  return BLOCK_SLOTS[`${blockType}:${path}`];
}

export interface SlotCheck {
  slot: Slot;
  problem: 'too_small' | 'wrong_shape';
  detail: string;
}

/** Compare a media file with a slot. Aspect ratios are compared with a 12 % tolerance (the client crops with `focal`). */
export function checkAgainstSlot(slot: Slot, width: number | null, height: number | null): SlotCheck | null {
  if (!width || !height) return null;
  if (width < slot.minWidth || (slot.minHeight !== undefined && height < slot.minHeight))
    return {
      slot,
      problem: 'too_small',
      detail: `${width}x${height} px is below the ${slot.minWidth}${slot.minHeight ? `x${slot.minHeight}` : ' px wide'} minimum`,
    };
  if (slot.aspect && slot.aspect !== 'free') {
    const [a, b] = slot.aspect.split(':').map(Number);
    if (a && b) {
      const want = a / b;
      const have = width / height;
      if (Math.abs(have - want) / want > 0.12)
        return {
          slot,
          problem: 'wrong_shape',
          detail: `shape ${have.toFixed(2)}:1 differs from the ${slot.aspect} slot; the crop will cut the picture`,
        };
    }
  }
  return null;
}
