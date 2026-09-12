/** Customer contract shared by the app and the dashboard. */

export interface Customer {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

export interface CustomerFilter {
  query?: string;
  createdAfter?: string;
}
