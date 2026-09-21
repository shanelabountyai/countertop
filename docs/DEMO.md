# Demo Script — Countertop

How to show this project to someone in 12 minutes, screen by screen, with the
exact commands, the accounts, and what to say at each stop.

**There are two ways to demo this.**

**Hosted:** <https://ordering.labintelligence.co>. The customer side is open to
anyone. The kitchen is behind the staff passcode
(`grep STAFF_PASSCODE .env.production.local`). Send the link when you can't be
there. **Its data is the rush that was loaded at deploy time.** The reset that
reloads it refuses to run against anything but a local database, and that is
deliberate. So the hosted queue shows old orders, not a lunch that is
happening now. Use it for the customer flow and for "can you show me
something you built?"

**Local:** everything below. It is the better demo when you are in the room,
because `demo:rush:live` stops a rush **twelve minutes in, as of now**. The
cards are 0–12 minutes old, one customer is five minutes late for pickup, and
the guacamole ran out four minutes ago.

Everything below assumes you are in the repo root.

**Contents**

- [The 60-second version](#the-60-second-version)
- [Before you start](#before-you-start): 5 minutes, and do it the day before
- [Credentials](#credentials)
- [What's on the menu, and who's in the queue](#whats-on-the-menu-and-whos-in-the-queue)
- [The demo, screen by screen](#the-demo-screen-by-screen)
- [The five ugly cases](#the-five-ugly-cases): the "prove it" section
- [If something goes wrong](#if-something-goes-wrong)
- [No-laptop version](#no-laptop-version)
- [What to concede before you're asked](#what-to-concede-before-youre-asked)

---

## The 60-second version

> Firebird Kitchen is a fast-casual burrito counter. Phone orders tie up staff
> in the rush and get written down wrong: "no onions" turns into extra onions.
> Delivery apps fix that but take a cut of every ticket. Countertop is the
> restaurant's own pickup ordering. The customer builds exactly what they want,
> at a price the **server** guarantees. The kitchen works from a live queue
> that chimes when a new order lands and keeps chiming until someone takes it.
>
> The interesting part isn't the menu. A placed order is a **copy** that can
> never change: edit a price at 4pm and the 2pm receipt doesn't move. Two
> customers hitting submit at the same instant get consecutive order numbers
> because the **database** refuses a duplicate, not because the code checked
> first. And a customer who double-taps "Place order" gets one order, and the
> same answer both times.

Then open `/kitchen` and let them look at the queue.

---

## Before you start

Do this the day before. The first dev-server compile is the slow part.

**Prerequisites:** Node, a local Postgres running, and `.env.local` present
(see [Credentials](#credentials)).

```bash
# 1. Migrations on the dev database (the one the demo uses).
npm run db:status:dev          # "Database schema is up to date!"
npm run db:migrate:dev         # only if it isn't

# 2. Load the rush, stopped twelve minutes in. Under five seconds.
#    Safe to re-run: it wipes and reseeds the DEV database every time.
npm run demo:rush:live

# 3. Start the app ON THE DEV DATABASE (see the warning below).
npm run dev:demo

# 4. In another terminal, once it's up: sign in, read the queue, check the report.
npm run smoke:demo             # 8/8 passed
```

> [!IMPORTANT]
> **`npm run dev` serves the *test* database, not the dev one.** The root `dev`
> script is `dev:test`, and it reads `.env.test` first, which wins. That is a
> different database from the one `demo:rush:live` just wrote. `dev:demo` reads
> `.env.local` only. Use `dev:demo` for every demo. If you don't, you'll open on
> an empty kitchen and spend the first three minutes of the meeting working out
> why.

**The rush prints its own summary.** Check it before you present. If these
numbers are different, the fixture has changed: run `npm test -- rush` before
you show it to anyone.

```
Stopped at minute 12, mid-service: 23 orders in so far.
Order numbers #1–#23, 23 distinct.
The ugly cases
  86 mid-rush     guacamole off at minute 8; 1 cart refused at the option grain, replaced a minute later
  no-show         Cass Iverson has been ready since minute 7 — 5 min on the shelf
Where they ended up
  accepted 5 · cancelled 1 · preparing 11 · placed 1 · ready 5
Sales
  0 orders sold, 0 items, $0.00 including tax
  no-show rate — (0 of 0 finished)
  22 orders still in flight, not booked
Open /kitchen — the queue is live, mid-service.
```

Two of those lines are worth reading out:

- **`no-show rate —`**, not `0%`. No order has finished yet, so the rate is
  unknown, not zero. A report that said 0% would be claiming a perfect service
  that hasn't happened.
- **`22 orders still in flight, not booked`**. Revenue is counted when an order
  is picked up, not when it is placed. Orders still in the kitchen are listed
  as open, not dropped from the totals.

**Open these tabs in this order** before anyone is watching:

1. `http://localhost:3400/menu`
2. `http://localhost:3400/menu/burrito`
3. `http://localhost:3400/kitchen` (sign in once at `/kitchen/login`. The cookie
   covers tabs 3–6)
4. `http://localhost:3400/kitchen/availability`
5. `http://localhost:3400/kitchen/report`
6. `http://localhost:3400/kitchen/loyalty`

---

## Credentials

Nothing real is committed. Read values from the file named, never from this one.

| What | Where | Note |
|---|---|---|
| Staff passcode, local | `grep STAFF_PASSCODE .env.local` | One shared passcode in front of every `/kitchen` route, including every POST. **If it isn't set, the kitchen is locked, not open.** |
| Staff passcode, hosted | `grep STAFF_PASSCODE .env.production.local` | Vercel stores its own copy as a Sensitive variable that can't be read back out. This file is the copy you can read. |
| Shift PINs | `packages/db/testing/index.ts` → `seedStaff` | **Noor Haddad `1234`**, **Theo Barnes `5678`**. **Wes Toma `9012` has left the restaurant and is deactivated.** Try that PIN and the shift is refused, but the taps Wes made earlier still show Wes's name. These demo values are committed on purpose: the seed only runs against a local database. The PIN is entered once per shift and records who made each tap. It is not a second sign-in. |
| Punch-card pepper | `LOYALTY_PHONE_PEPPER` in `.env.local` | Phone numbers are stored as a peppered hash. If the pepper is missing, loyalty refuses to run. It doesn't fall back to an unsalted hash. |
| Phone verification code | **On screen** | The SMS carrier is a stub, and it has no way to reach the customer except the page it is replying to, so the six-digit code is shown right there. Say so out loud. |

**Status-page tokens change on every reseed.** Look one up, never hardcode it:

```bash
psql countertop_dev -tA -F' | ' -c \
  "SELECT seq, \"customerName\", status, \"statusToken\" FROM \"Order\" ORDER BY seq"
```

Open `http://localhost:3400/status/<token>`. **Cass Iverson (#3)** is the good
one to show, because the order is `ready` and nobody has come to collect it.

---

## What's on the menu, and who's in the queue

**Firebird Kitchen**, 25 items across 5 categories. Burrito $10.95, burrito
bowl $11.95, taco plate $12.50, down to bottled water at $2.50.

**Eight modifier groups**, and three of them are the ones worth pointing at:

| Group | Rule | Why it matters |
|---|---|---|
| Protein | exactly 1 | **Required.** The only thing that makes a group required is a minimum above zero. There's no separate "required" flag that could disagree with it |
| Toppings (Onions, Cilantro, Cheese) | 0–3, **intensity** | none / light / regular / extra. Picking "none" is how a customer asks for **NO onions** |
| Salsa | 0–3, **intensity** | Choosing "extra" can cost more, so the price rules have to handle it |

**The people in the stopped rush who are worth knowing by name:**

| Customer | # | What they're for |
|---|---|---|
| Cass Iverson | 3 | Ready since minute 7 and hasn't come in. At minute 40 of the full rush the order is closed out as `abandoned` |
| Owen Brandt | 6 | **Cancelled.** The guacamole ran out while it was in the cart |
| Rae Sutton | 10 | In the full rush a cook marks the order ready by mistake, then undoes it. The undo is written to the log as a correction. Nothing is deleted |
| Sol Nakamura | 23 | **Placed and not yet accepted**, so this card is flashing and the chime is sounding |

---

## The demo, screen by screen

Twelve minutes at a normal pace. Each stop has **what's on screen**, **what to
say**, and **the point**. Short on time? Keep the point.

### 1 · The menu
`/menu` · screenshot `01-menu.png`

**On screen:** 25 items in five categories. Every one can be ordered, because
the thing the kitchen ran out of is an *option*, not a dish. Click the
burrito.

### 2 · The composer: sold out, and a price that isn't the authority
`/menu/burrito` · screenshot `02-composer.png`

**On screen:** Size, Protein (required), Toppings and Salsa with intensity
levels. Under Add-ons: **Guacamole — Sold out**. Set **Onions → none** and
**Salsa → extra** and watch the total update.

**Say about the guacamole:** "The kitchen ran out eight minutes into this rush.
The burrito is still on the menu, because you can make one without guac. So
availability is tracked for each dish *and* for each option. Whether a
particular burrito can be ordered is decided by **one function**, and the
menu, the cart and the final order all call it. If they used three copies,
one day they would give three different answers."

**Say:** "That price is for display only. The server works out every line
again when you add it to the cart, and again when you place the order. If the
browser sends a different total, the difference gets logged. It never gets
charged."

**The point:** the server sets the price. Someone who edits the page can't
change what they pay.

### 3 · The cart, with the NO carried through
Add it and open `/cart` · screenshot `03-cart.png`

**Say:** "The 'no onions' is still there as a request to leave something out.
It hasn't turned into a note someone has to read. Watch what it looks like
when it reaches the kitchen."

### 4 · The kitchen: why the product exists
`/kitchen` · screenshots `10-kitchen-viewport.png`, `06-kitchen-card.png` · **spend the most time here**

**On screen:** 22 live tickets across four states. **Sol Nakamura's card is
flashing and chiming.**

Point at four things:

- **A red `NO ONIONS` badge**, next to plain-text add-ons on the same card.
  A removal that looks like an addition is exactly the phone-order mistake
  this product exists to prevent.
- **The flashing card.** Tap to accept it. "The chime is driven by the order's
  status, not by the browser. Reload the page and it's still chiming, because
  the order is still waiting to be accepted. Accepting the order *is* the step
  that stops it. There's no separate button to acknowledge the alert."
- **Cass Iverson on the Ready shelf**, and that card.s age is going up.
- **The tap targets.** "This screen is read from arm's length by someone with
  greasy gloves. Every target is at least 48 pixels and the advance button is
  the biggest. The tests check those sizes."

**Then the undo:** advance a card, then tap undo within five seconds. "Undo
doesn't erase anything. It adds a correction to a log that can only be added
to, never edited, and the database enforces that with a trigger. The report
you're about to see is read straight from that log."

### 5 · Running out of something mid-rush
`/kitchen/availability`

**Say:** "Marking something as run out has to reach three places. The menu
shows it as sold out. Any cart that already has it gets flagged at checkout,
which happened to Owen. And orders already placed don't change at all. If
running out only updated the menu, Owen would have ordered a burrito we
couldn't make."

### 6 · The receipt that can't change
`/status/<Cass Iverson's token>` · screenshot `04-status.png`

**Say:** "This link is the customer's only key to their order. There's no
login and no order number in the address. The order number is a counter, so
anyone could count through them. Everything on this page, the item names and
the prices, was copied into the order when it was placed. Rename the
burrito, reprice it or delete an option, and this receipt doesn't change."

**The point:** that's a test, not a promise. `npm test -- snapshot` renames,
reprices, marks as run out and deletes every menu row an order used, then
checks the receipt byte for byte.

### 7 · The report, and a number that says "don't know"
`/kitchen/report` · screenshots `07-report-midservice.png`, `11-report-after.png`

**On screen:** $0.00 revenue, no-show rate "—", 22 orders still open, and
time spent in each state.

**Say:** "Midway through service nothing has been picked up. So revenue is
zero, and the no-show rate is a dash, not zero percent. A rate over zero
finished orders is unknown. The time in each state is read from the event
log, and days are counted in the restaurant's own timezone, not UTC."

**For the full-service version**, re-run `npm run demo:rush` (the whole twenty
minutes, every order finished) and refresh: 28 sold, $467.73, a 3% no-show
rate (1 of 29 finished), $9.90 refunded, and one refund still owed on the
exceptions list.

### 8 · The punch card
`/kitchen/loyalty` · screenshot `15-loyalty.png`

**Say:** "Six members. Two rewards have been spent so far. One was spent on
Owen's order, which was then cancelled, and those 100 points went back
automatically. Phone numbers are stored hashed with
a secret pepper, and if the pepper is missing, the loyalty program switches
off rather than storing them weakly."

---

## The five ugly cases

These are built into the seeded rush, which runs as both the demo and a test.
The rush test asserts every one: 47 assertions in about three seconds.

```bash
npm test -- rush               # 47 passed
```

| Case | What has to come out right |
|---|---|
| **Running out mid-rush** | Guacamole marked as run out at minute 8. Owen Brandt's cart is refused at checkout, for that one option only. He replaces it a minute later |
| **Wrong advance + undo** | Rae Sutton is marked ready at minute 12 and reverted at 13. The revert is a **logged event, not a delete** |
| **No-show** | Cass Iverson is ready at minute 7 and closed out as `abandoned` at 40. The no-show rate counts the order; revenue doesn't |
| **Double submit** | Theo Marsh submits twice. **One order, and the same response both times.** A duplicate-order guard alone wouldn't give the same response |
| **Orders while paused** | Three customers are turned away between minutes 15 and 18. One comes back and places the order |

**The result:** 30 orders, numbered #1–#30 with no gaps or repeats. That
includes three orders submitted at the same instant, which competed for the
next number through the database's uniqueness check. None stuck, lost or
duplicated.

The whole gate, if someone asks for it (it builds the app, so allow several
minutes):

```bash
npm run gate                   # lint, typecheck, unit, production build, e2e
```

---

## If something goes wrong

| Symptom | Cause | Fix |
|---|---|---|
| Empty kitchen, no orders | The server is on the **test** database | You ran `npm run dev`. Restart with `npm run dev:demo` |
| Every card is flagged from an earlier day | The rush was loaded yesterday | Re-run `npm run demo:rush:live`. The times are measured back from *now* |
| `/status/<token>` 404s | The token is from an earlier seed | Re-run the token query. Every seed creates new tokens |
| `/kitchen` bounces to login | No cookie yet | Sign in once at `/kitchen/login` |
| Wrong passcode on the hosted site | It isn't the local passcode | `grep STAFF_PASSCODE .env.production.local` |
| Hosted site returns 500s | Production database is behind on migrations | `npm run db:status:prod`, then `npm run db:migrate:prod`, then `npm run smoke:prod`. This is what took the live demo down for three weeks (`docs/WRITEUP.md`) |
| Port 3400 busy | Another project, or an old server | `lsof -ti :3400 \| xargs kill -9`. This repo owns 3400 |
| Rush summary numbers are different | The fixture has changed | Stop. `npm test -- rush` will show which case broke |
| e2e fails across unrelated specs straight after a demo | Playwright reused the `dev:demo` server on 3400, so it tested against the **dev** database | Never run e2e with `dev:demo` running. `lsof -ti :3400 \| xargs kill -9`, then run it again. Reseed with `demo:rush:live` afterwards, because the specs will have changed the dev database |
| Everything is slow | Too many dev servers running | `devservers`, then stop the ones you aren't demoing |

---

## No-laptop version

Fifteen screenshots in `docs/screenshots/`, all taken by Playwright against
the seeded rush. None of them are mockups. `docs/WRITEUP.md` → *The Screens*
has a caption for each one, and it works as a guided tour on its own.

| File | The one thing it shows |
|---|---|
| `10-kitchen-viewport.png` | The queue twelve minutes in: 22 tickets across four states |
| `06-kitchen-card.png` | A red NO ONIONS badge next to a plain-text add-on |
| `13-unpaid-card.png` | Money still owed, shown on the ticket |
| `14-leftover.png` | Yesterday's untouched tickets: flagged and counted, never cleared automatically |
| `02-composer.png` | Required groups, intensity levels, a price that isn't the authority |
| `07-report-midservice.png` | No-show rate "—", not 0% |
| `11-report-after.png` | The full service: time in each state, from the log |
| `09-price-confirm.png` | $10.95 typed as $109.50: the old price and the new one shown side by side before saving |
| `15-loyalty.png` | The punch card |

**To reshoot after a UI change.** Stop `dev:demo` first (see the table
above), then:

```bash
cd apps/web && SCREENSHOTS=1 npx dotenv -e ../../.env.test -e ../../.env.local -- \
  npx playwright test screenshots.spec.ts      # add --list first: "15 tests in 1 file"
```

Don't use `npm run test:e2e -- screenshots.spec.ts`. The root script drops
the trailing argument and runs the whole suite.

---

## What to concede before you're asked

Saying these yourself comes across as confidence. Having them pulled out of
you doesn't.

- **The restaurant and every customer are invented.** That's deliberate.
- **No card has ever been charged.** The payment provider is a mock with one
  implementation. Refunds are real entries in the event log, but no money
  moves. A real processor is on the P2 list.
- **No text has ever been sent.** The SMS carrier is a stub, which is why the
  verification code appears on screen.
- **The hosted data is frozen at deploy time.** The reset refuses to run
  against a non-local database, and that refusal is working as intended.
- **The kitchen checks for updates every five seconds, from every open
  screen.** At one restaurant that costs nothing. The cost grows with every
  connected screen, so it's the first thing to change at scale. The endpoint
  was built so a WebSocket could replace the polling without changing any
  logic.
- **One shared passcode, no user accounts.** The shift PIN records who made
  each tap. It isn't a login. That's right for a single counter and wrong for
  a chain.
- **Order numbers restart at midnight, restaurant time.** A deliberate
  simplification. The restaurant's timezone decides the day, and CI runs
  every test under two opposite timezones to prove it.
- **The live demo was down for three weeks and nothing reported it.**
  Auto-deployed code was running against a database 36 migrations behind.
  It's written up in full in `docs/WRITEUP.md`. Tell the story yourself.
  Owning it comes across far better than having someone find it.
