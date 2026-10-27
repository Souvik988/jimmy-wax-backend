import { api, ApiError } from '@/lib/api';
import { ActionForm } from '@/components/ui';
import { publishContentAction, saveContentAction } from '@/lib/actions';

interface List {
  items: Array<{
    slug: string;
    kind: string;
    title: string;
    version: number;
    status: string;
    updatedAt: string;
  }>;
}
interface Page {
  slug: string;
  kind: string;
  title: string;
  bodyMd: string;
  version: number;
  status: string;
}

export default async function Content({ searchParams }: { searchParams: Promise<{ slug?: string }> }) {
  const { slug } = await searchParams;
  const { items } = await api<List>('/content');
  let cur: Page | null = null;
  if (slug) {
    try {
      cur = await api<Page>(`/content/${encodeURIComponent(slug)}`);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) throw e;
    }
  }
  const suggested = ['terms', 'privacy-policy', 'refund-and-return-policy', 'shipping-policy', 'care-guide'];
  return (
    <>
      <h1>Policies &amp; guides</h1>
      <p className="sub">
        Every save creates a new immutable version. Customers only ever see the <b>published</b> text;
        publishing exposes the latest saved version. Legal wording must come from you or your adviser —
        nothing is pre-written.
      </p>
      <div className="tablewrap">
        <table>
          <caption className="skip">Pages</caption>
          <thead>
            <tr>
              <th>Page</th>
              <th>Kind</th>
              <th>Version</th>
              <th>Status</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {items.map((p) => (
              <tr key={p.slug}>
                <td>
                  {p.title}
                  <br />
                  <small>{p.slug}</small>
                </td>
                <td>{p.kind}</td>
                <td>{p.version}</td>
                <td>
                  <span className={`badge ${p.status === 'published' ? 'ok' : 'warn'}`}>{p.status}</span>
                </td>
                <td>
                  <a href={`/content?slug=${p.slug}`}>Edit</a>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <h2>{cur ? `Edit “${cur.title}”` : 'New page'}</h2>
      {!cur ? <p className="sub">Suggested slugs: {suggested.join(', ')}</p> : null}
      <ActionForm action={saveContentAction} submit="Save new version" className="">
        <div style={{ display: 'grid', gap: 10, maxWidth: 760 }}>
          {cur ? <input type="hidden" name="version" value={cur.version} /> : null}
          <label>
            Slug
            <input
              name="slug"
              required
              pattern="[a-z0-9\-]{2,60}"
              defaultValue={cur?.slug ?? slug ?? ''}
              readOnly={!!cur}
            />
          </label>
          <label>
            Kind
            <select name="kind" defaultValue={cur?.kind ?? 'policy'}>
              <option value="policy">policy</option>
              <option value="care_guide">care_guide</option>
              <option value="page">page</option>
            </select>
          </label>
          <label>
            Title
            <input name="title" required minLength={2} maxLength={160} defaultValue={cur?.title ?? ''} />
          </label>
          <label>
            Body (Markdown)
            <textarea name="bodyMd" required rows={14} defaultValue={cur?.bodyMd ?? ''} />
          </label>
        </div>
      </ActionForm>
      {cur ? (
        <ActionForm
          action={publishContentAction}
          submit={cur.status === 'published' ? 'Re-publish latest version' : 'Publish'}
        >
          <input type="hidden" name="slug" value={cur.slug} />
        </ActionForm>
      ) : null}
    </>
  );
}
