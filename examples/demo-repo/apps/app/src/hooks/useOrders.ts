import type { Order, OrderFilter } from '@acme/contracts';
import { fetchOrders } from '../api/orders.js';

/** Tiny hook-shaped loader (no React dependency so the fixture needs no install). */
export interface OrdersState {
  loading: boolean;
  orders: Order[];
  error: string | null;
}

export function useOrders(filter: OrderFilter): { load: () => Promise<OrdersState> } {
  return {
    async load() {
      try {
        const page = await fetchOrders(filter);
        return { loading: false, orders: page.items, error: null };
      } catch (err) {
        return { loading: false, orders: [], error: err instanceof Error ? err.message : String(err) };
      }
    },
  };
}
