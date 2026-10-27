import { api } from '@/lib/api';
import { ConfirmAction } from '@/components/ui';
import { moderateMediaAction, moderateReviewAction } from '@/lib/actions';

interface R {
  items: Array<{
    id: string;
    productId: string;
    rating: number;
    title: string;
    body: string;
    status: string;
    verifiedPurchase: boolean;
    createdAt: string;
    photos: Array<{ id: string; status: string; width: number; height: number }>;
  }>;
}

export default async function Reviews({ searchParams }: { searchParams: Promise<{ status?: string }> }) {
  const { status = 'pending' } = await searchParams;
  const { items } = await api<R>(`/reviews?status=${encodeURIComponent(status)}`);
  return (
    <>
      <h1>Review moderation</h1>
      <p className="sub">
        Only verified purchasers can review. Photos are re-encoded on upload (metadata removed) and stay
        private until you approve them. Approving a review does not publish its photos automatically.
      </p>
      <form className="filters">
        <label>
          Show
          <select name="status" defaultValue={status}>
            {['pending', 'approved', 'rejected'].map((s) => (
              <option key={s}>{s}</option>
            ))}
          </select>
        </label>
        <button className="btn">Filter</button>
      </form>
      {items.length === 0 ? <p className="card">Nothing here.</p> : null}
      {items.map((r) => (
        <article key={r.id} className="card" style={{ marginBottom: 12 }}>
          <h2 style={{ marginTop: 0 }}>
            {'★'.repeat(r.rating)}
            {'☆'.repeat(5 - r.rating)} {r.title}
          </h2>
          <p>{r.body}</p>
          <p className="sub">
            {r.productId} · {r.verifiedPurchase ? 'verified purchase' : 'unverified'} ·{' '}
            {r.createdAt.slice(0, 10)}
          </p>
          {r.photos.map((p) => (
            <div key={p.id} style={{ display: 'inline-block', marginRight: 12, verticalAlign: 'top' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={`/api/review-media/${p.id}`}
                alt="Customer photo awaiting moderation"
                width={160}
                style={{ display: 'block', borderRadius: 8 }}
              />
              <span className="badge">{p.status}</span>
              {p.status === 'pending' ? (
                <>
                  <ConfirmAction
                    action={moderateMediaAction}
                    label="Publish photo"
                    danger={false}
                    warning="The photo becomes public on the product page."
                    hidden={{ id: p.id, approve: 'yes' }}
                  />
                  <ConfirmAction
                    action={moderateMediaAction}
                    label="Reject photo"
                    warning="The stored photo is deleted."
                    hidden={{ id: p.id, approve: 'no' }}
                  />
                </>
              ) : null}
            </div>
          ))}
          {r.status === 'pending' ? (
            <div>
              <ConfirmAction
                action={moderateReviewAction}
                label="Approve review"
                danger={false}
                warning="The review becomes public (without the author's name)."
                hidden={{ id: r.id, approve: 'yes' }}
              />{' '}
              <ConfirmAction
                action={moderateReviewAction}
                label="Reject review"
                warning="The review and any pending photos are hidden."
                hidden={{ id: r.id, approve: 'no' }}
              />
            </div>
          ) : null}
        </article>
      ))}
    </>
  );
}
