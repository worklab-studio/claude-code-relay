# acme-portal (Relay demo fixture)

A deliberately tiny TypeScript monorepo used by `scripts/demo.sh` in the Relay repository
(DESIGN.md §12 M0). Two developers share it:

| area        | paths                                | owner |
|-------------|--------------------------------------|-------|
| `app`       | `apps/app/**`                        | priya |
| `dashboard` | `apps/dashboard/**`                  | arjun |
| `contracts` | `packages/contracts/**`, `prisma/**` | shared |

`packages/contracts/src/orders.ts` exports `OrderFilter`; `apps/app/src/hooks/useOrders.ts`,
`apps/app/src/api/orders.ts`, `apps/dashboard/src/hooks/useOrders.ts` and
`apps/dashboard/src/OrdersTable.tsx` import it, so a change to the contract lights up
dependents in both areas. `.relay.json` is the area map (§5.4); it matches the hub's demo seed.

Nothing needs installing: there is no lockfile, no build and no type-check; the demo only
edits, commits and greps these files.
