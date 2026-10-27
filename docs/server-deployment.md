# Server deployment and device sync

The server uses Node.js, PostgreSQL and a persistent file directory. PostgreSQL stores users, token hashes, structured records, sync changes and resource indexes; article bodies and images are files. The server does not fetch original sites or call models, and needs no outbound internet access during normal operation. Clients keep their own data and can read and review offline, syncing later.

## Docker Compose

Use Docker Engine and Compose v2. The root `compose.yaml` runs `server` and `postgres`, with no public database port and separate named volumes for the database and article files.

1. Copy `compose.yaml` and `.env.example` into a deployment directory, then copy `.env.example` to `.env`.
2. Set `FOCUS_SERVER_IMAGE` to a published `ghcr.io/<owner>/lectern-server:<version>` or `@sha256:...` digest. Images are published by successful Server image runs for `v*` tags; old releases do not automatically gain images.
3. Generate a database password with `openssl rand -hex 32` and set `POSTGRES_PASSWORD`. Hex avoids connection-URL escaping issues.
4. Configure HTTPS and allowed client origins before starting.

```bash
docker compose config --quiet
docker compose pull
docker compose up -d
docker compose ps
docker compose logs --tail=100 server
```

Startup applies versioned migrations. The non-root container has a read-only program directory and writes files under `/data`. If replacing its volume with a host directory, grant UID 1000 access.

The default host binding is `127.0.0.1:8787`, intended for an HTTPS reverse proxy. A proxy in another container can join the Docker network and use `server:3000`. For LAN or VPN access, explicitly set `BIND_ADDRESS` to a reachable interface. Production clients require HTTPS; plain HTTP is accepted only on local development hosts.

The proxy must preserve `Authorization`, support PUT/POST/GET/HEAD/OPTIONS, accept at least 16 MiB JSON requests and 32 MiB file requests, and allow slow mobile uploads. Proxy the API only; never expose the file directory as static hosting. Enter the root URL in clients, such as `https://sync.example.com`, without `/v1`.

`CORS_ORIGINS` is a comma-separated list of exact origins without paths or trailing slashes. The template includes Android's `https://appassets.androidplatform.net`; add actual browser-preview or `chrome-extension://<extension-id>` origins as needed. Wildcards are not supported. Requests without Origin still require tokens.

A new GHCR package may be private. Publish its visibility in GitHub package settings or authenticate the deployment host with a `read:packages` credential. That image-pull credential is separate from client sync tokens.

## Accounts and device tokens

Run administrative commands from the Compose directory; no public registration page or management API is required.

```bash
docker compose exec server npm run admin -- create-user alice
docker compose exec server npm run admin -- list-users
docker compose exec server npm run admin -- issue-token <userId> phone
docker compose exec server npm run admin -- list-tokens <userId>
docker compose exec server npm run admin -- revoke-token <tokenId>
```

`create-user` creates an account and its first token; `issue-token` adds a credential to an existing account. Save the returned token in a password manager. Only its hash is stored, so a lost token cannot be recovered through `list-tokens`; issue a replacement. Prefer separate tokens for each device so they can be revoked individually. Keep tokens, command output and `.env` out of the repository.

## Connecting clients

In **Settings → Device sync**, enter the server URL and token. **Test connection** checks the user and server IDs without saving settings or uploading records. Then choose **Save and enable sync**.

The first sync merges existing local and account data. The status panel reports whether sync is enabled, queued changes, last success and errors. **Sync now** starts a manual cycle. Reading/translation preferences sync by field; model settings, keys, tokens, consent and device-specific preferences remain local. The translation allowlist is local. Diagnostic logs and usage counts upload separately when sync is enabled.

| Action | Effect |
| --- | --- |
| Pause sync | Keep connection settings and queued changes; continue recording locally. |
| Disconnect | Remove the local token, keeping records and their account binding. |
| Clear this device's records | Disconnect, clear local records and binding, preserve ordinary settings and model keys; do not delete server data. |
| Change account/server | Export a backup, clear this device's records, then connect to the new identity. Already-bound data cannot silently switch accounts. |

Reconnecting the original account restores server records. Explicit article deletion creates sync tombstones; it is different from clearing one device. Deleted translations sync too. Cards remain visible while any source remains; orphaned cards retain review history and regain their schedule when a matching source returns.

New JSON exports can include review events and a scheduling baseline. Imports and sync deduplicate by event ID. Older card-only exports migrate as a baseline and cannot reconstruct historical ratings.

Local records, pending operations and cursors persist together. Failed uploads or process exits can retry. The server deduplicates operation IDs and transactionally writes merged state and ordered changes. Incompatible protocol versions produce an error while preserving local data.

## Article files and resources

Clients upload article content; the server receives no source-site cookies and does not log in to websites. Files are scoped by user and content hash. Uploads verify size and SHA-256 before publishing an index. Downloads require a sync token; clients cannot choose disk paths.

1. Open the article in the desktop browser, log in if necessary, and let its text and images load.
2. Choose **Save article to sync library** in the popup. Content is saved locally, then uploaded when connected.
3. If images are missing, retry after loading finishes. Login, anti-hotlinking, cross-origin or interaction requirements can still prevent capture.
4. Sync Android and open the saved article. Its body and images download on first open.
5. **Available offline** means the downloaded content can be read without a network. Missing resources display a notice and can retry after reconnection.

Syncing the list does not download the entire library. Ordinary URL caches do not become archives automatically; saved article-review text can sync separately. Archive readers neither execute source scripts nor refetch the original URL. Interactive sites may not reproduce fully.

Change logs, operation receipts, tombstones and old article resources are retained for long-offline clients. Clearing one device does not delete server files. Do not manually remove individual files from the volume: database references may still exist. Monitor storage growth and back up both stores.

## Diagnostics

Requests produce JSON logs containing route templates, status, duration, sizes, user IDs and batch counts. They exclude headers, bodies, tokens and query strings; successful health probes are omitted. Compose rotates server logs across five 10 MiB files.

```bash
docker compose logs --no-log-prefix --since 24h server | grep '^{' | jq -c 'select(.ms > 500 or .status >= 500)'
docker compose exec -T server node dist/server/src/admin.js stats
docker compose exec -T server node dist/server/src/admin.js check
docker compose exec -T server node dist/server/src/admin.js show-record <userId> <type> <id>
docker compose exec -T server node dist/server/src/admin.js usage [userId]
docker compose exec -T server node dist/server/src/admin.js logs [userId] --hours=24
```

`stats` reports counts, sizes and identifiers. `check` performs read-only protocol, log and file consistency checks and exits with 1 on errors. `show-record` exposes a selected record and its changes/operations. `usage` aggregates button counts by platform. `logs` exposes uploaded diagnostic content, including selected text and raw model responses. Use these interfaces for investigation rather than connecting directly to PostgreSQL. See the [server diagnostics reference](../server/README.md#diagnostics).

## Configuration

| Variable | Default or requirement |
| --- | --- |
| `DATABASE_URL` | Required; constructed by Compose, or supplied directly |
| `HOST` / `PORT` | Direct run: `0.0.0.0:8787`; container: `0.0.0.0:3000` |
| `DATA_DIR` | Direct run: `./data`; container: `/data` |
| `CORS_ORIGINS` | Android app origin by default; comma-separated |
| `MAX_JSON_BYTES` | 16 MiB |
| `MAX_BLOB_BYTES` | 32 MiB |
| `MAX_USER_BLOB_BYTES` | 2 GiB |
| `FOCUS_SERVER_IMAGE` | Required by Compose; pin a version or digest |
| `POSTGRES_IMAGE` | `postgres:17-alpine` |
| `POSTGRES_PASSWORD` | Required for initial database creation |
| `BIND_ADDRESS` / `HTTP_PORT` | `127.0.0.1:8787` |

Changing `.env` after initialization does not change the PostgreSQL role's password automatically. Coordinate database administration when rotating it. PostgreSQL major-version upgrades require a supported upgrade or dump/restore process, not just a new image tag.

## Updates, backup and recovery

Back up the database and file volume, change the server image version in `.env`, then run:

```bash
docker compose pull server
docker compose up -d server
docker compose ps
```

Do not update with `docker compose down -v`: it deletes persistent volumes. Migrations may not be readable by older binaries. Check rollback compatibility and restore a matching backup when required.

Example consistent backup with application writes stopped; do not run mutating admin commands during it:

```bash
mkdir -p backup
docker compose stop server
docker compose exec -T postgres pg_dump -U focus -d focus -Fc > backup/database.dump
docker compose run --rm --no-deps --entrypoint tar server -C /data -czf - . > backup/articles.tar.gz
docker compose start server
```

Check each command's exit status. Separately preserve `.env`, Compose configuration and image version/digest. Protect backups: they contain private reading content and credential hashes. Neither the database nor file archive alone is complete.

Restore into a **new, empty environment**, using the application and PostgreSQL major version from the backup:

```bash
docker compose up -d --wait postgres
docker compose exec -T postgres pg_restore -U focus -d focus --no-owner --exit-on-error < backup/database.dump
docker compose run --rm --no-deps -T --entrypoint tar server -C /data -xzf - < backup/articles.tar.gz
docker compose run --rm --no-deps server npm run admin -- rotate-server-id
docker compose up -d server
```

After restoring an older backup, devices may have cursors newer than its history. Run `rotate-server-id` **before accepting client connections** and restart all server instances. This prevents clients from writing against rolled-back history under the old identity.

Devices will report the identity change. Export each device's remaining data, preserve unsynced article content separately, clear local records and connect to the restored server, then import the records you need to recover. Disconnecting alone does not clear the old binding. JSON exports omit full archive resources; previously uploaded bodies/images need the matching file backup. Verify account identity, archived files and new-record sync with a test device before reopening access.

## Image publishing

`.github/workflows/server.yml` checks client/server code, runs PostgreSQL integration tests and builds `linux/amd64` and `linux/arm64` images for main, PRs and manual runs without publishing. Successful `v*` tags publish to `ghcr.io/<owner>/lectern-server`.

Root and server package versions and lockfiles must match the tag. Images receive version and full-commit `sha-…` tags; stable releases also update `latest`, prereleases do not. Workflows use scoped package-write permissions and pinned Actions. The run summary shows the digest. Production deployments should pin a version or digest.

The same tag triggers extension and APK releases. Builds and pulls need network access; the running server does not. For offline deployment, pull matching-architecture server/PostgreSQL images elsewhere, transfer them with `docker save`/`docker load`, then start with `docker compose up -d --pull never`.

## Local development

Use Node.js 22.14 or newer and a separate PostgreSQL development database:

```bash
npm ci
npm --prefix server ci
npm --prefix server run build
npm --prefix server run admin -- create-user developer
npm --prefix server start
```

Set `DATABASE_URL` before the admin/start commands. Run `npm --prefix server test`; database integration tests require a dedicated test database. Build an image from the repository root with `docker build -t lectern-server:dev .`, then use that tag as `FOCUS_SERVER_IMAGE`.
