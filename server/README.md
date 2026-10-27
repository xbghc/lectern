# Lectern sync server

Node.js 22 and PostgreSQL store structured records; article bodies and images live in user-isolated directories under `DATA_DIR`. The server has no feature that actively fetches external sites or calls models. See the [deployment guide](../docs/server-deployment.md) for Docker Compose and GHCR images.

## Development

```sh
cd server
npm ci
npm run build
export DATABASE_URL=postgresql://focus:password@localhost:5432/focus
export DATA_DIR=./data
npm run admin -- create-user "My account"
npm start
```

Startup and admin commands apply versioned migrations. `create-user` prints a user ID, token ID and a token shown only once. `issue-token <userId> [label]` adds a device credential; `revoke-token <tokenId>` revokes one. The database stores only the token's SHA-256 hash. `list-users` and `list-tokens <userId>` expose neither tokens nor hashes.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Required | PostgreSQL connection string |
| `HOST` | `0.0.0.0` | Listen address |
| `PORT` | `8787` | HTTP port |
| `DATA_DIR` | `./data` | Persistent file directory |
| `CORS_ORIGINS` | `https://appassets.androidplatform.net` | Comma-separated exact origins; no wildcards |
| `MAX_JSON_BYTES` | `16777216` | Maximum JSON request size |
| `MAX_BLOB_BYTES` | `33554432` | Maximum file size |
| `MAX_USER_BLOB_BYTES` | `2147483648` | Per-user file quota |

Allow `https://appassets.androidplatform.net` for Android. Add the full `chrome-extension://<extension-id>` origin when extension requests include it. Native requests without an Origin still require authentication. Terminate HTTPS at a reverse proxy and set request-size, connection and rate limits there. Keep the database and file directory private.

## HTTP protocol v1

Except for `GET /health` and CORS preflight, requests require `Authorization: Bearer <token>`. Identity comes only from the token; URLs and request bodies cannot select another user.

| Endpoint | Request and response |
| --- | --- |
| `GET /health` | `200 {status:"ok",protocol:1}`; 503 if the database is unavailable |
| `GET /v1/info` | `{serverId,userId,userName,protocol:1}` |
| `POST /v1/sync/push` | `{deviceId,operations:[{opId,record}]}` → `{accepted:[opId],head}`; at most 200 operations |
| `GET /v1/sync/pull?cursor=0&limit=200` | `{records,cursor,hasMore}`; at most 500 records and about 2 MiB, with at least one record |
| `GET /v1/sync/snapshot` | Creates an immutable snapshot and returns `{token,head,records,cursor,hasMore,expiresAt}` |
| `GET /v1/sync/snapshot?token=…&cursor=…&limit=200` | Continues that snapshot; pull incremental changes from its `head` after completion |
| `PUT /v1/blobs/<sha256>` | Raw bytes with MIME `Content-Type` → `{hash,size}` |
| `GET` / `HEAD /v1/blobs/<sha256>` | Current user's resource only; 404 when absent |
| `POST /v1/archives` | Publishes a manifest → `{accepted,head,record}` |
| `POST /v1/usage` | `{deviceId,platform,days:{"2026-09-19":{"articles.detail":3}}}` → `{accepted,ignored}` |
| `POST /v1/logs` | `{deviceId,platform,version,entries:[{kind,entry}]}` → `{accepted,ignored}` |

Record validation and merge rules are shared with `src/sync/protocol.ts`. Operation IDs are idempotency keys. Reusing an ID with different content returns `409 OPERATION_REUSED` and rolls back the batch. A user write lock covers sequence assignment, current state, change log and receipts in one transaction. The upload response's `head` must not overwrite the download cursor. Advance that cursor only after records are durably stored locally.

Snapshot pagination uses a fixed watermark; later changes never enter an existing snapshot. Each user may retain eight unexpired snapshots, expiring after 24 hours. Resume with the returned token instead of creating a new snapshot on every retry. Change history, tombstones and idempotency receipts are retained without compaction.

### Archive manifests

```json
{
  "articleId": "https://example.org/article",
  "version": "new-version-uuid",
  "title": "Article title",
  "url": "https://example.org/article",
  "htmlHash": "64-character-lowercase-sha256",
  "resources": [{ "hash": "64-character-lowercase-sha256", "mime": "image/png", "size": 12345 }],
  "missingResources": [],
  "createdTs": 1700000000000
}
```

Optional `stamp`, `generation` and `opId` align a manifest with client operations; otherwise the server assigns the next logical version. Upload the body and all declared resources first. Resource sizes and version immutability are checked within the transaction that publishes the article, references and sync log. Missing resources are explicitly listed rather than presented as a complete backup.

Uploads use a temporary file in the same directory, verify SHA-256, flush to disk, atomically publish the file, then commit metadata. A database user lock protects quota checks; other writes for that user wait during upload. Responses use `attachment`, `nosniff` and a script-blocking CSP. Clients consume bytes in a controlled reader. The server accepts neither arbitrary file paths nor source URLs to fetch.

## Diagnostics

Use these interfaces for investigation rather than querying the database directly.

Each completed request writes JSON to stdout, except successful health probes:

```json
{"ts":"2026-09-19T08:22:19.927Z","method":"POST","route":"/v1/sync/push","status":200,"ms":20,"user":"<userId>","device":"<deviceId>","ops":4,"head":13,"in":1802,"out":180}
```

`route` is a template (`/v1/blobs/:hash`, or `unknown`); `in`/`out` are Content-Length values. `error` is the client-facing code. Aborted responses use status 0 and `ABORTED`. Push logs include `device`, `ops`, `head`; pull/snapshot logs include `records`, `cursor`, `hasMore`. Logs omit headers, bodies, tokens, query strings and resource hashes. HTTP 500 also writes a stack to stderr. Database error messages may mention the offending input, but driver `detail` and `where` fields are not emitted.

Admin commands return JSON:

| Command | Output |
| --- | --- |
| `stats` | Database/table sizes, approximate rows, dead tuples, scan counts; per-user heads, record/change counts and bytes, receipts, snapshots, resources, device activity, ten largest and most rewritten records. Counts and identifiers only. |
| `check [userId]` | Read-only consistency report. Errors include `invalid-record`, `key-mismatch`, `log-gap`, `log-mismatch`, `sequence-ahead`, `archive-version-missing`, `blob-file-missing`. Warnings include `expired-snapshots`, `orphan-file`, `upload-leftover`. Errors return exit code 1; output is capped at 1,000 issues with `truncated: true` when needed. |
| `show-record <userId> <type> <id>` | Record content: current value, latest 50 changes and latest 50 original uploaded operations. |
| `usage [userId]` | Daily button-count aggregates by platform, including unused controls. |
| `logs [userId] [--hours=24] [--kind=…] [--all] [--limit=100]` | Uploaded diagnostic content, which may include model output and selected text. |

`check` needs the same `DATA_DIR` as the service. Invoke Node directly for JSON without npm's banner:

```sh
docker compose exec -T server node dist/server/src/admin.js stats
docker compose exec -T server node dist/server/src/admin.js check
docker compose logs --no-log-prefix --since 24h server | grep '^{' | jq -c 'select(.ms > 500 or .status >= 500)'
```

## UI usage counts

After a successful sync, clients upload cumulative daily workspace-button counts. `ui_usage` stores one row per device, local date and event. These are not sync records and are never pulled by clients.

- Each count is a day's total, not a delta. The server keeps the larger value, so duplicates and out-of-order requests are harmless. Clearing a device generates a new device ID.
- Platforms are `extension` and `app`. Event IDs allow lowercase letters, digits, dots and hyphens, up to 64 characters. Newer-client IDs are accepted and reported under `unknown`.
- A request allows 120 days, 200 events/day, and integer counts from 1 to one billion. Invalid structure returns 400. Dates outside 400 days ago through the day after tomorrow are ignored and counted in `ignored`, so a bad device clock cannot cause endless rejected retries.
- Uploads update device `last_seen_at`; request logs include device and accepted row count.
- Counts are retained for historical comparisons and deleted with the user.

`usage` returns overall dates, users and devices, plus per-platform `users`, `devices`, `deviceDays`, `events`, `unused` and `unknown`. Every known event has `last7`, `last30`, `total`, users and devices, including zero-use events. Local-date boundaries introduce about one day of ambiguity across devices.

```sh
docker compose exec -T server node dist/server/src/admin.js usage | jq '.platforms[] | {platform, deviceDays, unused}'
```

The server compiles the client's `src/lib/uiUsage.ts`, so display labels follow the deployed server version. Event IDs remain stable across translations.

## Client diagnostic logs

After successful sync, clients upload new or updated entries from Diagnostics. `client_logs` stores one row per device, kind and entry with its original payload; it is not downloaded through sync. Unlike usage counts, these entries can contain selected text, context and raw model output. Translation previews include the first 160 characters of selected text.

- Kinds are `failure`, `timing`, `translation`, `fetch` and `error`. Platform and client version accompany each request.
- Translation entries deduplicate by their mutable `id`; other kinds use a content SHA-256. Retries are idempotent without operation receipts.
- A request allows 500 entries. Invalid structure returns 400. Entries over 256 KB or outside the accepted time window (400 days ago through the day after tomorrow) are ignored and counted.
- Retention is 30 days by entry timestamp, cleaned on each user upload. User deletion removes its logs.
- Uploads update device activity and log the accepted entry count.

`logs` returns device/platform/version activity, failures grouped by source/type/HTTP status/recovery, translation statuses and newest-first entries. The default 24-hour report includes failures, errors and unsuccessful translations. `--kind=timing` selects one kind; `--all` includes every kind.

```sh
docker compose exec -T server node dist/server/src/admin.js logs --hours=48
docker compose exec -T server node dist/server/src/admin.js logs --kind=translation --limit=20
```

## Backup and recovery

Stop writes before backing up both PostgreSQL and `DATA_DIR`, or use a verified consistent-backup method. A database-only backup is incomplete. Old archive versions and unreferenced resources are retained to protect offline clients. Failed uploads can leave unreferenced files or `.upload` files; do not delete content-hash files based only on age.

Before reopening client access after restoring an older backup, run `npm run admin -- rotate-server-id` and restart all server instances. The new identity prevents old client cursors from being reused against rolled-back history. A cursor beyond the current head returns `409 CURSOR_AHEAD`. Rebinding and merging local data requires deliberate user action; data absent from both backups and surviving devices cannot be recovered automatically.

## Verification

```sh
npm run typecheck
npm test
npm run build
```

With `DATABASE_URL`, integration tests create a random isolated schema and verify migrations, credentials, user isolation, idempotency, rollback, concurrent sequencing, snapshots, deletion merges, references and quotas. Only that schema is removed afterward; use a dedicated test database. Without a connection, the integration suite is explicitly skipped. GitHub Actions supplies PostgreSQL for it.
