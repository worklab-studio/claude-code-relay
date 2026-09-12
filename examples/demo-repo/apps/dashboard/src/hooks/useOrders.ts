import type { Order, OrderFilter, OrderPage } from '@acme/contracts';

/** Dashboard-side loader: the ops dashboard reads orders across all customers. */
export async function loadOrders(filter: OrderFilter): Promise<Order[]> {
  const res = await fetch('/internal/orders', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(filter),
  });
  if (!res.ok) throw new Error(`orders: ${res.status}`);
  const page = (await res.json()) as OrderPage;
  return page.items;
}
