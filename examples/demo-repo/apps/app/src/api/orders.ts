import type { Order, OrderFilter, OrderPage } from '@acme/contracts';
import { DEFAULT_ORDER_PAGE_SIZE } from '@acme/contracts';

/** Client for the orders API used by the customer-facing app. */
export async function fetchOrders(filter: OrderFilter, cursor: string | null = null): Promise<OrderPage> {
  const params = new URLSearchParams();
  if (filter.customerId) params.set('customerId', filter.customerId);
  if (filter.from) params.set('from', filter.from);
  if (filter.to) params.set('to', filter.to);
  if (filter.minTotal !== undefined) params.set('minTotal', String(filter.minTotal));
  params.set('limit', String(DEFAULT_ORDER_PAGE_SIZE));
  if (cursor) params.set('cursor', cursor);
  const res = await fetch(`/api/orders?${params.toString()}`);
  if (!res.ok) throw new Error(`orders: ${res.status}`);
  return (await res.json()) as OrderPage;
}

export async function fetchOrder(id: string): Promise<Order> {
  const res = await fetch(`/api/orders/${encodeURIComponent(id)}`);
  if (!res.ok) throw new Error(`order ${id}: ${res.status}`);
  return (await res.json()) as Order;
}
