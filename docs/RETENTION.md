# Data retention, and forgetting a customer

*PRD 6 P0-4, shipped as C-091. Written down because an undocumented capability
is one nobody uses when the email arrives.*

## What Countertop keeps about a person

Three fields on the order, plus one per line:

| Where | What |
|---|---|
| `Order.customerName` | the name called out at the counter |
| `Order.customerPhone` | optional, and only ever typed by the customer |
| `Order.orderNote` | free text — "blue Honda out front" |
| `OrderLine.note` | free text per item — "cut in half please" |

Everything else on an order is **what was sold**: the order number, the money,
the line and option names, the tax rate, the prep weight, the quote, and every
row of the append-only event log. None of it names anybody.

Separately, `LoyaltyMember` holds a *digest* of a phone number (never the
number), the last four digits, and a display name. It is out of scope here and
is handled by C-105 — deleting a member cascades its ledger.

## The window

`RestaurantSettings.retentionDays`, default **365**, with a
`retentionDays > 0` CHECK. There is no screen for it; change it with SQL and a
migration if it ever needs to move.

365 is not arbitrary and it is not conservative. Loyalty points expire after
365 days of inactivity (decision 10 of 2026-09-02), so the purchase history
behind a punch card has to outlive that. **Nothing else in this product needs a
named person's history for a year** — the loyalty program is what drives this
retention policy, which is recorded in `docs/WRITEUP.md` as a cost of building
it rather than as a feature.

## Running the sweep

```
npm run db:retention          # the local dev database
npm run db:retention:prod     # production
```

It prints the window it used and how many orders it forgot. Running it twice
is safe and the second run reports zero — it selects only orders that still
have something to remove.

**It is not scheduled.** A cron that destroys data wants a secret, an endpoint
and a way to see that it ran, which is a feature and not a line of config; this
is a command a person runs. Until it is scheduled, running it is a calendar
task, not a guarantee.

## Forgetting one customer, now

Staff receipt → **Forget this customer** → confirm. Reachable from
`/kitchen/orders`, in every order state, and irreversible.

It does exactly what the sweep does, to exactly the same columns — one function
(`forgetOrders` in `packages/db/retention.ts`) serves both, so the button and
the job cannot drift apart.

## What a forget does NOT do

- **It does not move a single number.** `packages/db/retention.test.ts` asserts
  the sales report is byte-identical across a sweep. If that test ever fails,
  the sweep is wrong, not the test.
- **It does not delete the order.** The order number, the money and the
  activity log are the shop's own records of a sale.
- **It is not itself logged.** No event is written, so *who* pressed the button
  is not recorded. That is a deliberate ceiling, not an oversight: an event
  kind for this would mean one row per order per night forever. If it needs to
  be attributable, that is the change to make.
- **It does not reach an off-site backup, a log line or an export.** Log lines
  never carried a name (C-084); backups are the platform's and are out of
  scope.

## When the email arrives

1. Find the orders. `/kitchen/orders` searches by name and by order number.
2. Open each receipt and use **Forget this customer**.
3. If they were also a loyalty member, delete the member — C-105 is the item
   that gives that a screen. Until then it is a `DELETE FROM "LoyaltyMember"`
   by digest, and the ledger cascades with it.
4. Reply. Nothing else in the product holds their details.
