# dannebrud-rss

Tiny **public** companion to the private [dannebrud](https://github.com/casperstorm/dannebrud) project.

GitHub Actions polls a short list of Danish news RSS feeds, keeps items whose title/summary match cyber-incident keywords (Danish + English), dedupes by link via `seen.json`, and POSTs only new matches to a Grok Bot webhook.

This repo does **not** contain private dannebrud site code or data.

## Secrets (required)

In the repo: **Settings → Secrets and variables → Actions** → add:

| Name | Value |
| --- | --- |
| `WEBHOOK_URL` | Webhook URL from the Grok Bot routine **“Dannebrud RSS webhook”** panel |
| `WEBHOOK_KEY` | Auth key from the same panel (sent as the HTTP `Authorization` header value as-is — include a `Bearer ` prefix in the secret if the bot expects one) |

Never commit these values. The workflow does not print them.

## Enable Actions

1. Push/merge to `main` (or enable Actions on this repo if first use).
2. Add `WEBHOOK_URL` and `WEBHOOK_KEY` as above.
3. **Actions** → **Poll RSS → webhook** → **Run workflow** (manual test), or wait for the `*/15` cron.
4. Runs outside **07–22 Europe/Copenhagen** exit early on schedule; **workflow_dispatch** always runs.

## What gets posted

One JSON POST per run when there is at least one new match:

```json
{
  "items": [
    {
      "feed": "Version2",
      "title": "…",
      "link": "https://…",
      "date": "2026-01-15T10:00:00.000Z",
      "summary": "…"
    }
  ]
}
```

If there are zero new items, the job exits `0` and does not POST.

## Deduping

- `seen.json` lists link URLs already handled.
- On an empty `seen.json` (first run), matching items older than ~48 hours are recorded as seen but **not** POSTed (avoids flooding).
- The workflow commits updates to `seen.json` with `[skip ci]` and also uploads it as an Actions artifact.

## Local dry run

```bash
npm ci
DRY_RUN=1 npm run poll
```

Optional real POST (do not commit `.env`):

```bash
export WEBHOOK_URL='…'
export WEBHOOK_KEY='…'
npm run poll
```

## Manual test checklist

1. Set `WEBHOOK_URL` + `WEBHOOK_KEY` from the Grok Bot **Dannebrud RSS webhook** panel.
2. Actions → **Poll RSS → webhook** → **Run workflow**.
3. Confirm the run is green; if matches existed, the bot received `{ "items": […] }`.
4. Re-run: same links must not POST again (`seen.json` updated).

## Layout

| Path | Role |
| --- | --- |
| `feeds.json` | Priority RSS list |
| `poll.mjs` | Fetch, filter, dedupe, POST |
| `seen.json` | Persisted seen links |
| `.github/workflows/poll.yml` | Cron + manual dispatch |
