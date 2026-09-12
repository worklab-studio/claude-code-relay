import type { Order, OrderFilter } from '@acme/contracts';

export interface OrdersTableProps {
  orders: Order[];
  filter: OrderFilter;
  onFilterChange: (next: OrderFilter) => void;
}

/** Ops dashboard table. Columns mirror the Order contract; add a column when the contract grows. */
export function OrdersTable({ orders, filter, onFilterChange }: OrdersTableProps) {
  return (
    <table className="orders">
      <thead>
        <tr>
          <th>Order</th>
          <th>Customer</th>
          <th>Total</th>
          <th>Placed</th>
        </tr>
      </thead>
      <tbody>
        {orders.map((o) => (
          <tr key={o.id}>
            <td>{o.id}</td>
            <td>
              <button type="button" onClick={() => onFilterChange({ ...filter, customerId: o.customerId })}>
                {o.customerId}
              </button>
            </td>
            <td>
              {o.total.toFixed(2)} {o.currency}
            </td>
            <td>{o.placedAt}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
