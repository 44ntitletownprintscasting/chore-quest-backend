# Deploy — Fly.io (~$2/month)

The backend runs on Fly.io's smallest machine: shared CPU, 256MB RAM,
about $2/month, plus a 1GB persistent volume for the SQLite database
(also ~$0.15/GB/month). The app stays awake (`auto_stop_machines =
false`) so the Chore Quest app always reaches it.

> **Do not deploy until Justin confirms.** Deploy needs a card on file
> in Fly.io Billing (known open item from the marketplace work) and the
> Play service-account setup below.

## 1. Install flyctl and log in

```bash
curl -L https://fly.io/install.sh | sh
fly auth login
```

## 2. Create the app (first time only)

From this directory:

```bash
fly launch --no-deploy --name chore-quest-backend --region ord
```

`--name` must be globally unique on Fly.io — if it is taken, pick
another name and update `fly.toml` (`app = '...'`) and the URL below.
`fly launch` reuses the `fly.toml` already in this repo; answer "no" if
it asks to set up a database (SQLite on a volume is used instead) and
"no" to deploying yet.

## 3. Create the persistent volume (first time only)

```bash
fly volumes create chore_quest_data --size 1 --region ord
```

Without this, the SQLite file would be lost on every deploy.

## 4. Set up the Google Play service account (Justin-side, Play Console)

Server-side purchase verification needs a service account with access
to the Play Developer API. No webhook — the Android app sends the
purchase token to `POST /api/billing/verify` and this server checks it
with Google.

1. Play Console → **Setup → API access** → create/link a service
   account (Google Cloud project), and grant it access to the Chore
   Quest app (Account permissions → the app, with financial data
   permission for subscription verification).
2. In Google Cloud Console → IAM & Admin → Service Accounts → the
   account → Keys → **Add key → JSON**. Download the JSON key file.
3. Store it as a Fly secret (never in chat or the repo):
   ```bash
   fly secrets set GOOGLE_SERVICE_ACCOUNT_JSON="$(cat /path/to/service-account-key.json)"
   ```
   The server also accepts a path to a key file, but on Fly.io the
   inline-JSON secret is the way to pass it.
4. Create the two subscription products in Play Console first
   (Setup → Products → Subscriptions), with the 7-day free trial offer
   on each base plan:
   - `chore_quest_pro_monthly` — $4.99/mo
   - `chore_quest_pro_yearly` — $39.99/yr

Until the secret is set, the server runs fine but
`POST /api/billing/verify` answers `503 "billing verification not
configured"` — it never invents a verification. Families stay on the
free plan (1 child) until a real verification succeeds.

`DATABASE_PATH`, `PORT` and `PLAY_PACKAGE_NAME` are already set in
`fly.toml`; do not override them. Confirm the package name
(`com.playmadecreations.chorequest`) matches the app id created in
Play Console — it is permanent once the app is created.

## 5. Deploy

```bash
fly deploy
fly status
curl https://chore-quest-backend.fly.dev/health
```

Expected: `{"ok":true,"service":"chore-quest-backend","version":"1.0.0","billing_configured":true}`.
Check logs with `fly logs`.

## 6. End-to-end test (after deploy)

```bash
API=https://chore-quest-backend.fly.dev

# 1. Sign up a family (parent)
curl -s -X POST $API/api/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"parent@example.com","password":"secret123"}'
# → {"token":"...","family":{"id":"...","email":"parent@example.com"}}
TOKEN=<token from above>

# 2. Add a kid + a chore, run it through start → done → approve
curl -s -X POST $API/api/kids -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Sam","pictureCode":["🌟","🐶","🍎"]}'
# → kid object; note the id
curl -s -X POST $API/api/chores -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"kidId":"<kid id>","name":"Brush teeth","valueCents":50,"date":"2026-11-17","steps":["Brush top","Brush bottom"]}'

# 3. Kid sign-in (picture code) and full state
curl -s -X POST $API/api/auth/signin-kid -H 'Content-Type: application/json' \
  -d '{"email":"parent@example.com","kidId":"<kid id>","pictureCode":["🌟","🐶","🍎"]}'
curl -s $API/api/state -H "Authorization: Bearer $TOKEN"
# → state.money shows earned/balance; state.kids[0].petXp is 1 after approval

# 4. Billing without credentials (before step 4) answers 503:
curl -s -X POST $API/api/billing/verify -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"productId":"chore_quest_pro_monthly","purchaseToken":"test"}'
# → {"error":"billing verification not configured"} (HTTP 503)
```

Billing end-to-end (real purchase → verify → plan becomes `pro` or
`trial`) can only be tested once the Play Console app, the two products,
and the service account exist, and the Android app is built with real
Play Billing. Until then, step 4 above is the honest check.

## Useful commands

```bash
fly logs            # tail server logs
fly status          # machine + volume status
fly ssh console     # shell into the machine
fly secrets list    # which secrets are set (values are never shown)
fly deploy          # redeploy after code changes
fly scale count 1   # keep exactly one machine running
```

## Notes

- There is **no webhook**: the plan is set when the client calls
  `POST /api/billing/verify` with a fresh purchase token (after
  purchase, and again on app launch / restore, which re-verifies and
  refreshes the plan). If a subscription later expires or is cancelled,
  the plan only changes when the client next verifies — the client
  should re-verify on launch.
- The plan changes **only** through that verify endpoint. There is no
  endpoint that sets the plan directly.
- Back up the SQLite file before any manual surgery:
  `fly ssh console` then copy `/data/chore-quest.db` off the volume.
