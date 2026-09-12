/**
 * Order contracts shared by the app and the dashboard.
 * Everything exported from this file is consumed across areas: changes here are
 * routed by Relay to whoever depends on them.
 */

export type OrderStatus = 'draft' | 'placed' | 'paid' | 'shipped' | 'cancelled';

export interface Order {
  id: string;
  customerId: string;
  total: number;
  currency: string;
  placedAt: string;
}

export interface OrderFilter {
  customerId?: string;
  from?: string;
  to?: string;
  minTotal?: number;
}

export interface OrderPage {
  items: Order[];
  nextCursor: string | null;
}

export const DEFAULT_ORDER_PAGE_SIZE = 50;
