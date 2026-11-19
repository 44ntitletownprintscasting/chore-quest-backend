# Deploy the backend via GitHub Actions

The Muse VM cannot reach Fly.io's remote builders (its network blocks
the builder connections), so the image is built on GitHub's runner
instead, which has direct internet. The Fly app (`chore-quest-backend`)
and its 1GB volume already exist — this only builds and ships the image.

## What you need

- A GitHub account (free is fine).
- The code zip (from Muse) and the Fly deploy-token link (from Muse).
  The token link expires in 24 hours — paste it into GitHub promptly.
  The token itself is good for 1 year and only works for this one app.

## Steps

### 1. Create the repo

1. Go to https://github.com/new (sign in first).
2. Repository name: `chore-quest-backend`.
3. Private is fine. Leave "Add a README" unchecked — start empty.
4. Click **Create repository**.

### 2. Upload the code

1. On your PC, download the code zip from Muse's link and unzip it.
   You get a folder called `chore-quest-backend`.
2. Open that folder, press **Ctrl+A** to select everything inside it
   (all files plus the `.github` folder — that folder is what makes
   the automatic deploy work, so make sure it is selected).
3. In the new empty repo on GitHub, click **"uploading an existing
   file"**, then drag everything you selected into the page.
   The files must land at the repo root — NOT inside a
   `chore-quest-backend/` subfolder. You should see `fly.toml`,
   `Dockerfile`, `package.json` and `.github` at the top level.
4. Click **Commit changes**.

### 3. Add the Fly token as a secret

1. In the repo, go to **Settings → Secrets and variables → Actions**.
2. Click **New repository secret**.
3. Name: `FLY_API_TOKEN`
4. Value: open Muse's token link, copy the whole token (it starts
   with `FlyV1 ` — copy every character, including that prefix and
   the space after it), paste it in.
5. Click **Add secret**.

### 4. Deploy

1. Go to the repo's **Actions** tab → **Deploy to Fly.io** (left side).
2. Click **Run workflow** → **Run workflow**. (It also runs by itself
   on every push to `main`.)
3. Wait for it to go green (a few minutes). If it goes red, tell Muse
   — the log shows what failed.

### 5. Verify (Muse does this)

Muse checks `https://chore-quest-backend.fly.dev/health` and runs the
signup → kid → chore → approve smoke test. Expected health reply:
`{"ok":true,"service":"chore-quest-backend","version":"1.0.0",
"billing_configured":false}` — `billing_configured` stays `false`
until the Google Play service account is set up (separate step, done
later from the VM with `fly secrets set`; it does not block the deploy).

## Later deploys

Any push to `main` redeploys automatically. To ship a code change,
upload the changed files to the repo (or push with git) — no token or
dashboard work needed again.

## If the token link expired

Tell Muse — a fresh token link takes a minute, and the old token gets
revoked. Never paste the token anywhere except the GitHub secret.
