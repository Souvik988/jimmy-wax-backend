'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';

const ITEMS: Array<{ href: string; label: string; perm: string }> = [
  { href: '/', label: 'Dashboard', perm: 'orders:read' },
  { href: '/orders', label: 'Orders', perm: 'orders:read' },
  { href: '/inventory', label: 'Inventory', perm: 'inventory:read' },
  { href: '/catalog', label: 'Catalog & prices', perm: 'catalog:read' },
  { href: '/returns', label: 'Returns', perm: 'orders:read' },
  { href: '/refunds', label: 'Refunds', perm: 'payments:read' },
  { href: '/reviews', label: 'Reviews', perm: 'reviews:moderate' },
  { href: '/content', label: 'Policies & guides', perm: 'catalog:read' },
  { href: '/shipping', label: 'Shipping areas', perm: 'orders:read' },
  { href: '/settings', label: 'Store settings', perm: 'settings:read' },
  { href: '/ops', label: 'Queues', perm: 'ops:read' },
  { href: '/audit', label: 'Audit log', perm: 'audit:read' },
  { href: '/security', label: 'My security', perm: '*' },
];

/** Hiding links is convenience only — the API enforces every permission again. */
export function Nav({ permissions }: { permissions: string[] }) {
  const path = usePathname();
  return (
    <nav aria-label="Primary">
      <ul className="nav">
        {ITEMS.filter((i) => i.perm === '*' || permissions.includes(i.perm)).map((i) => {
          const current = i.href === '/' ? path === '/' : path.startsWith(i.href);
          return (
            <li key={i.href}>
              <Link href={i.href} aria-current={current ? 'page' : undefined}>
                {i.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
