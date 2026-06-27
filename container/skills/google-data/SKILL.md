---
name: google-data
description: Query Google Analytics 4 and YouTube Analytics through thin auth-proxy scripts. Use when the user asks about site traffic, page performance, conversions, video views, watch time, subscriber growth, audience demographics, or any analytics question covered by GA4 or YouTube. Construct the API request body yourself using the public schemas — the scripts handle authentication and forward the request as-is.
---

# google-data — GA4 & YouTube Analytics access

The host mounts `~/.google-data/` (read-only) at `/workspace/google-data`.
Inside it: credentials and two thin auth-proxy scripts. **You construct the
API request; the scripts handle auth and proxy the request.** The full GA4
Data API and YouTube Analytics API surface is reachable through these two
scripts — no per-query wrappers exist or are needed.

## Layout (in container)

```
/workspace/google-data/
├ ga4-key.json           ← GA4 service-account key (optional; ga4.mjs prefers this)
├ ga4-config.json        ← { "defaultProperty": "..." }
├ yt-token.json          ← OAuth refresh token (covers YT + GA4 if scopes
│                          include analytics.readonly; ga4.mjs falls back to
│                          this when ga4-key.json is absent)
├ yt-config.json         ← { "defaultChannel": null }   (null → MINE)
└ bin/
    ├ ga4.mjs            ← stdin = request body, stdout = response
    └ yt.mjs             ← stdin = params, stdout = response
```

Setup is done on the host, not by you. If a script reports a missing key or
token, tell the user to run setup — do not attempt to create credentials.

## GA4 — `bin/ga4.mjs`

Universal endpoint is `runReport`: metrics over date ranges, sliced by
dimensions, with filters. ~95% of analytics questions resolve here.

**Invocation:**

```bash
echo '<request-body>' | node /workspace/google-data/bin/ga4.mjs \
    [--property X] [--method runReport|batchRunReports|runPivotReport|getMetadata|runRealtimeReport]
```

`--property` defaults to `ga4-config.json`'s `defaultProperty`. `--method`
defaults to `runReport`. The script injects `property: "properties/<id>"` into
the request automatically — do **not** include it in the body.

**Example: top 10 pages this week by views**

```bash
echo '{
  "dateRanges": [{"startDate": "7daysAgo", "endDate": "today"}],
  "dimensions": [{"name": "pagePath"}],
  "metrics":    [{"name": "screenPageViews"}],
  "orderBys":   [{"metric": {"metricName": "screenPageViews"}, "desc": true}],
  "limit": 10
}' | node /workspace/google-data/bin/ga4.mjs
```

**Example: traffic sources, sessions + conversions, last 30 days**

```bash
echo '{
  "dateRanges": [{"startDate": "30daysAgo", "endDate": "today"}],
  "dimensions": [{"name": "sessionSource"}, {"name": "sessionMedium"}],
  "metrics":    [{"name": "sessions"}, {"name": "conversions"}],
  "limit": 25
}' | node /workspace/google-data/bin/ga4.mjs
```

For unfamiliar metrics/dimensions, run `--method getMetadata` (request body
can be `{}`) to discover what's available on this property.

## YouTube — `bin/yt.mjs`

Two APIs share one script: **YouTube Analytics** (default) and **YouTube
Data API v3**.

**Invocation:**

```bash
echo '<params>' | node /workspace/google-data/bin/yt.mjs \
    [--api analytics|data] [--method dotted.path] [--channel UC...]
```

If `ids` is omitted from analytics params, falls back to
`channel==<defaultChannel>` or `channel==MINE` (the authenticated channel).

**Date format:** YouTube Analytics API requires `YYYY-MM-DD` only — relative
forms like `7daysAgo` are GA4-only and will error here. Use Bash to compute
relative dates:

```bash
START=$(date -d "14 days ago" +%Y-%m-%d) && END=$(date +%Y-%m-%d)
```

**Example: views and watch time per day, last 14 days**

```bash
echo "{
  \"startDate\": \"$START\",
  \"endDate\":   \"$END\",
  \"metrics\":   \"views,estimatedMinutesWatched,averageViewDuration\",
  \"dimensions\":\"day\",
  \"sort\":      \"day\"
}" | node /workspace/google-data/bin/yt.mjs
```

**Example: top 10 videos by views, last 30 days**

```bash
START=$(date -d "30 days ago" +%Y-%m-%d) && END=$(date +%Y-%m-%d)
echo "{
  \"startDate\": \"$START\",
  \"endDate\":   \"$END\",
  \"metrics\":   \"views,estimatedMinutesWatched,averageViewPercentage\",
  \"dimensions\":\"video\",
  \"sort\":      \"-views\",
  \"maxResults\":10
}" | node /workspace/google-data/bin/yt.mjs
```

**Example: traffic sources for the channel, last 7 days**

```bash
START=$(date -d "7 days ago" +%Y-%m-%d) && END=$(date +%Y-%m-%d)
echo "{
  \"startDate\": \"$START\",
  \"endDate\":   \"$END\",
  \"metrics\":   \"views,estimatedMinutesWatched\",
  \"dimensions\":\"insightTrafficSourceType\"
}" | node /workspace/google-data/bin/yt.mjs
```

**Example (Data API): list channel statistics**

```bash
echo '{"part": "snippet,statistics", "mine": true}' | \
  node /workspace/google-data/bin/yt.mjs --api data --method channels.list
```

## Patterns

### Synthesizing across sources

When a user asks a cross-source question (e.g. "did the YouTube launch drive
traffic?"), run the relevant queries on each source, then write the narrative
yourself. The scripts return raw JSON; turning rows into insight is your job.

### Cross-lead context

If `_Shared/Snapshots/` or `_Shared/Campaigns/` exist in the shared Obsidian
mount, read them before composing analytical reports — they hold the other
Madisons' published context (campaigns, outreach response rates, etc.).
You do not need to share data via IPC; Obsidian is the substrate.

### Self-scheduling

If the user wants a recurring report (e.g. "send me a weekly traffic summary
every Monday at 9am"), use the `schedule_task` MCP tool. The scheduled task's
prompt should describe the desired report; you'll run the queries and compose
the output when it fires. No special wiring is needed.

### Errors

- `Service-account key not found` (GA4) or `OAuth token not found` (YT) →
  setup is incomplete. Tell the user, do not attempt to fix it from inside
  the container.
- `API error: …` → forward the message to the user. Common causes: invalid
  metric/dimension names (use `getMetadata` to discover valid ones), insufficient
  permissions on the property/channel, or a malformed request body.
- `Analytics API error: Forbidden` (YT) → the authorized Google account is not
  an owner/manager of the channel. Either re-authorize with the channel-managing
  account, or add the current account as a manager in YouTube Studio.

### Method-specific request shapes

Most GA4 methods take `{ property: "properties/X", ... }` (the script injects
this for you). One exception: `getMetadata` takes
`{ name: "properties/X/metadata" }` instead. Construct the body accordingly
and pass `--property` is fine — the script's auto-injection of `property:`
will be ignored if `name:` is present.

### What you can and cannot do

- **Can:** any read query the GA4 Data API or YouTube Analytics/Data API
  supports. Construct request bodies freely using the public schemas.
- **Cannot:** write/modify operations. Credentials are read-only by design
  (GA4 SA has Viewer; YT OAuth scopes are `*.readonly`). Don't try to upload
  videos, modify playlists, or change GA4 settings — they will fail.
