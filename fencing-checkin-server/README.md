# Fencing Check-In — free-tier internet deployment

This version is meant to run as a normal website — not on Claude, not tied to any local
WiFi. Fencers on university WiFi, guest WiFi, or their own cellular data can all reach it,
because it's a real internet URL rather than a local IP address.

Three free accounts, ~20 minutes total:

1. **GitHub** — to hold the code so Render can deploy it.
2. **Render** — runs the server itself, gives you a free `https://your-app.onrender.com` URL.
3. **Upstash** — a free always-on key-value store, so the roster/log survive even though
   Render's free web services restart when idle (their local disk does not).

Google Sheets sync (optional) is unchanged from before and doesn't need its own account
beyond the Google account you already have.

## 1. Push this folder to GitHub

Create a new (private is fine) GitHub repository and push this folder's contents to it.
If you're not comfortable with git, GitHub's web UI lets you drag-and-drop upload the
files directly — you don't strictly need the command line.

## 2. Create the Upstash database (free, persistent)

1. Go to upstash.com and sign up (free).
2. Create a new **Redis** database — any region close to you is fine, free tier is enough.
3. On the database's page, find **REST API** — copy the `UPSTASH_REDIS_REST_URL` and
   `UPSTASH_REDIS_REST_TOKEN` values. You'll paste these into Render next.

## 3. Deploy to Render (free)

1. Go to render.com, sign up, and choose **New > Web Service**.
2. Connect the GitHub repo you pushed in step 1.
3. Build command: `npm install`. Start command: `npm start`. Instance type: **Free**.
4. Under **Environment**, add two environment variables:
   - `UPSTASH_REDIS_REST_URL` = (the value from step 2)
   - `UPSTASH_REDIS_REST_TOKEN` = (the value from step 2)
5. Click **Create Web Service**. After a minute or two you'll get a live URL like
   `https://fencing-checkin.onrender.com` — that's the link fencers and coaches use.

That's it — no IP addresses, no shared WiFi requirement, no domain to buy.

> Free note: Render's free web services fall asleep after 15 minutes with no visitors and
> take ~30–60 seconds to wake back up on the next visit. That's fine for a practice — the
> first check-in of the day might just take a few extra seconds to load. Because state now
> lives in Upstash rather than on Render's disk, nothing is lost while it's asleep.

## 4. First-time setup in the app

1. Open your Render URL, click **Coach view**, and set a coach PIN.
2. Choose **Static code / QR** (print it, tack it to a wall) or **Rotating QR**
   (put a phone/tablet on the tripod and tap **Present fullscreen**).

## 5. Connect a Google Sheet (optional but recommended)

1. Create a new Google Sheet.
2. **Extensions > Apps Script**, delete the starter code, paste in
   `google-apps-script/Code.gs` from this project.
3. **Deploy > New deployment > Web app**. Execute as **Me**, access **Anyone**. Deploy,
   authorize, and copy the URL (ends in `/exec`).
4. In the Coach dashboard, paste that URL into **Google Sheet sync** and click **Save**.
   Every check-in/out now mirrors to the sheet automatically. If the server was ever
   offline, hit **Sync now** to catch up on anything missed.

## What the data looks like

Every event is just three fields — a name, `in` or `out`, and a timestamp. Nothing else
is collected. It's stored as one JSON blob in Upstash (the "backend"), and mirrored as
plain rows in your Google Sheet:

| Name | Action | Time |
|------|--------|------|
| Ava Chen | in | 2026-09-08 6:02 PM |
| Ava Chen | out | 2026-09-08 7:45 PM |

## Updating the app later

Push changes to the GitHub repo — Render redeploys automatically. Your data isn't
affected, since it lives in Upstash, not on Render itself.
