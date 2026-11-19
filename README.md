# Chore Quest backend

Small Node + Express + SQLite API server for the Chore Quest kids chore
app (Android app + web client). Family accounts, kids, chores, prizes,
payouts, PIN, and Google Play subscription verification.

**No ads, no analytics, no location, no AD_ID.** Kids never create
accounts — the parent creates the family account and kids sign in by
first name + 3-picture code. The weekly payout is cash, parent to child,
outside the app; this server never holds or moves money.

## Run locally

```bash
npm install
PORT=8788 DATABASE_PATH=./data/chore-quest.db npm start
curl http://localhost:8788/health
# {"ok":true,"service":"chore-quest-backend","version":"1.0.0","billing_configured":false}
```

Config comes from the environment only (see `.env.example`). The server
refuses to start without `PORT`. Without
`GOOGLE_SERVICE_ACCOUNT_JSON` the server still runs fine — only
`POST /api/billing/verify` is disabled (503), it never invents a
verification.

## API

Auth is a Bearer token from signup / sign-in; sessions last 30 days.
All errors are `{ "error": "plain message" }`.

| Method | Endpoint | Who | What |
|---|---|---|---|
| GET | `/health` | anyone | `{"ok":true, ...}` |
| POST | `/api/auth/signup` | — | `{email, password}` → `{token, family}` |
| POST | `/api/auth/signin-parent` | — | `{email, password}` → `{token, family}` |
| POST | `/api/auth/signin-kid` | — | `{email, kidId, pictureCode:[g,g,g]}` → `{token, kid}`. `kidId` is the cached kid id when the device has seen the family before, otherwise the typed first name (resolved case-insensitively; ambiguous names are rejected) |
| POST | `/api/auth/signout` | signed in | deletes this session |
| GET | `/api/state` | signed in | full family state + money summary |
| POST | `/api/kids` | parent | add a child (trial/free plan: 1 max → 403) |
| DELETE | `/api/kids/:id` | parent | removes the child + their chores/prizes |
| POST | `/api/kids/:id/picture-code` | parent | set the 3-picture code |
| POST | `/api/kids/:id/pet` | kid (own) / parent | pick fox, lion, panda, bunny, dinosaur, cat — keeps XP + accessory |
| POST | `/api/kids/:id/pet-accessory` | kid (own) / parent | hat (3 XP), bow (6 XP), star (10 XP), or null |
| POST | `/api/chores` | parent | `{kidId, name, valueCents, date, steps?, repeatWeekly?}` |
| PATCH | `/api/chores/:id` | parent | name / value / steps / repeatWeekly (toggle applies to the whole series) |
| DELETE | `/api/chores/:id` | parent | |
| POST | `/api/chores/:id/start` | kid | earns a Starter Star (recorded; no prize yet) |
| POST | `/api/chores/:id/done` | kid | → `pending` (waiting for parent approval) |
| POST | `/api/chores/:id/approve` | parent | → `approved`, unlocks the game; first approval gives the pet +1 XP, exactly once |
| POST | `/api/chores/:id/reject` | parent | → back to `todo` |
| POST | `/api/chores/:id/steps/:index/toggle` | kid | check/uncheck one step |
| POST | `/api/chores/:id/claim-prize` | kid, after approval | `{prizeId}` → records the win, chore → `complete` |
| GET | `/api/prizes` | signed in | the family's 8 game prizes |
| PATCH | `/api/prizes/:id` | parent | rename / relabel / re-icon / recolour |
| POST | `/api/prizes/reset` | parent | restores the original 8 (won prizes keep the name they were won with) |
| POST | `/api/payouts/mark-paid` | parent | `{kidId, weekStart, amountCents}` — idempotent: same kid/week returns the existing record, never a duplicate |
| PATCH | `/api/payouts/:id` | parent | change the amount |
| DELETE | `/api/payouts/:id` | parent | week returns to unpaid |
| POST | `/api/pin/set` | parent | `{pin:"0000"-"9999", currentPin?}` — changing needs the current PIN |
| POST | `/api/pin/verify` | signed in | `{pin}` → `{ok, hasPin}` (the kid-side PIN pad) |
| POST | `/api/display-modes` | signed in | `{calmMode?, focusMode?}` — kids may toggle calm mode without a PIN; focus mode is parent-only |
| GET | `/api/billing/products` | anyone | the two Play products |
| POST | `/api/billing/verify` | parent | `{productId, purchaseToken}` → `{plan, planPeriod}` (503 when Play is not configured) |

### Money — computed server-side in `GET /api/state`

`state.money` is `{earnedCents, paidCents, balanceCents,
owedThisWeekCents, weekStart, perKid: [...]}`.

- **Earned** = approved + played (claimed) chores, all time.
- **Balance** = earned − paid.
- **Owed this week** = this week's earned − this week's recorded payouts, floored at $0 in the header.
- `state.weeksStillToPay` lists kid/weeks where earned > paid (finished weeks, plus the current week from Sunday onward) — the payout reminder.

### Repeat-weekly chores

A repeat-weekly chore carries into each new week on the same weekday,
with the same steps (unchecked), amount and child, until the parent
turns the toggle off. Carry-over runs when `/api/state` is read and is
idempotent: one copy per week, never duplicates. Turning the toggle off
applies to the whole series.

### Plans

- `free` / `trial`: 1 child max (`POST /api/kids` → 403 otherwise).
- `pro`: unlimited children/chores.
- The plan changes **only** via `POST /api/billing/verify` after a real
  Google Play verification — there is no endpoint that sets the plan
  directly. A subscription in its free-trial offer phase sets `trial`;
  a paid active subscription sets `pro`.

### Billing products

| Product ID | Period | Price |
|---|---|---|
| `chore_quest_pro_monthly` | monthly | $4.99/mo |
| `chore_quest_pro_yearly` | yearly | $39.99/yr |

Both carry the 7-day free trial offer on their base plan in Play Console.

## Project layout

```
chore-quest-backend/
  src/
    index.js      Express app, CORS, rate limits, error handling
    config.js     env config (fails fast without PORT)
    db.js         SQLite schema, data access, money + repeat carry-over
    auth.js       PBKDF2 hashing, sessions, auth middleware
    billing.js    Google Play Developer API verification
    routes.js     the whole API contract
    util.js       dates, validation, pet rules, default prizes
  fly.toml        Fly.io app chore-quest-backend (ord, 256MB, 1GB volume)
  Dockerfile      Node 24 slim
  DEPLOY.md       deploy + Play setup steps
```

## Deploy

See [DEPLOY.md](DEPLOY.md). Short version: `fly launch`, create the
`chore_quest_data` volume, set the Play service-account secret, `fly deploy`.
Do **not** deploy until Justin confirms — it needs a card on file in
Fly.io Billing (~$2.35/mo).
