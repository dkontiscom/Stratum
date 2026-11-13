# Stratum — Deployment Guide

A full, step-by-step walkthrough for standing up Stratum on your own Cloudflare account, seeding
storage, creating a user, and (for home storage) exposing a Garage/MinIO server safely with a
Cloudflare Tunnel.

> **Status note.** Stratum is a feature-complete, unit-tested v1 (122 passing tests), but it has
> not yet been deployed to a live Cloudflare account or verified end-to-end against a real
> Subsonic client. These steps describe the intended operator flow; expect to shake out details on
> your first real deploy.

Everything happens from the repository root unless noted.

---

## 1. Prerequisites

- **Node.js** (a current LTS) and npm. `wrangler` and the test tooling are pulled in by
  `npm install`; you do not need a global wrangler.
- A **Cloudflare account** (the free tier is enough to start — the importer is sized to stay under
  free-tier limits).
- An **S3-compatible bucket** holding your audio, with an access key / secret key pair. This can be
  Cloudflare R2, Backblaze B2, AWS S3, or a self-hosted Garage/MinIO (see §9 for exposing a home
  server).
- Authenticate wrangler with your Cloudflare account:

  ```sh
  npx wrangler login
  ```

---

## 2. Install dependencies

```sh
npm install
```

---

## 3. Create the D1 database

```sh
npx wrangler d1 create stratum-db
```

This prints a block like:

```
[[d1_databases]]
binding = "DB"
database_name = "stratum-db"
database_id = "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

Copy the **`database_id`** value and paste it into **`wrangler.jsonc`**, replacing the
`"YOUR_D1_DATABASE_ID"` placeholder:

```jsonc
"d1_databases": [
  {
    "binding": "DB",
    "database_name": "stratum-db",
    "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
  }
]
```

Keep the binding name `DB` and database name `stratum-db` as they are — the code and the other
commands here reference them by those names.

---

## 4. Load the schema

Apply `schema/schema.sql` to your **remote** D1 database:

```sh
npx wrangler d1 execute stratum-db --remote --file=./schema/schema.sql
```

For local development against `npm run dev`, load it into the **local** D1 instead (a separate
on-disk copy under `.wrangler/`):

```sh
npx wrangler d1 execute stratum-db --local --file=./schema/schema.sql
```

The schema is idempotent (`CREATE TABLE IF NOT EXISTS …`), so re-running it is safe.

---

## 5. Set secrets

Secrets are stored in Cloudflare, never in the repo or `wrangler.jsonc`. There are two kinds:

**a) The bootstrap admin password.** This backs the built-in `admin` account (username comes from
the `ADMIN_USERNAME` var in `wrangler.jsonc`, default `admin`) and lets you authenticate before any
real user row exists:

```sh
npx wrangler secret put ADMIN_PASSWORD
```

**b) Per-backend storage credentials.** For each storage backend you add in §6, you choose a
`secret_ref` prefix (e.g. `GARAGE_HOME`). The Worker then looks up two secrets named
`<SECRET_REF>_ACCESS_KEY` and `<SECRET_REF>_SECRET_KEY`. So for `secret_ref = 'GARAGE_HOME'`:

```sh
npx wrangler secret put GARAGE_HOME_ACCESS_KEY
npx wrangler secret put GARAGE_HOME_SECRET_KEY
```

> The `<SECRET_REF>` must match the `secret_ref` value in the backend's `storage_backends` row
> exactly (it is used verbatim as the prefix). Use a simple uppercase identifier.

---

## 6. Seed a storage backend

Storage backends live in the D1 `storage_backends` table, one row per backend. Insert a row with
`wrangler d1 execute --command`. The real columns are:

| Column       | Meaning |
|--------------|---------|
| `id`         | Short stable id, e.g. `garage-home`. |
| `name`       | Human-readable name. |
| `type`       | `r2` \| `s3` \| `garage` \| `b2`. |
| `endpoint`   | Base URL of the S3-compatible API (a **public hostname** — see §9). |
| `region`     | Region, or `auto` if the provider doesn't care (Garage/R2). |
| `bucket`     | Bucket name. |
| `role`       | `primary` \| `fast` \| `backup` \| `lowq`. |
| `priority`   | Integer; **lower = preferred** when several backends hold the same track (default 100). |
| `secret_ref` | Prefix naming the credential secrets from §5 (e.g. `GARAGE_HOME`). |
| `enabled`    | `1` to include it in scanning/streaming, `0` to disable. |

**Home Garage example:**

```sh
npx wrangler d1 execute stratum-db --remote --command \
  "INSERT INTO storage_backends (id, name, type, endpoint, region, bucket, role, priority, secret_ref, enabled) \
   VALUES ('garage-home', 'Home Garage', 'garage', 'https://music.example.com', 'auto', 'music', 'primary', 100, 'GARAGE_HOME', 1)"
```

**Cloudflare R2 / AWS S3 example** (R2 via its S3-compatible endpoint — zero egress fees):

```sh
npx wrangler d1 execute stratum-db --remote --command \
  "INSERT INTO storage_backends (id, name, type, endpoint, region, bucket, role, priority, secret_ref, enabled) \
   VALUES ('r2-main', 'R2 Main', 'r2', 'https://<accountid>.r2.cloudflarestorage.com', 'auto', 'music', 'primary', 50, 'R2_MAIN', 1)"
```

Then set that backend's secrets to match its `secret_ref`:

```sh
npx wrangler secret put R2_MAIN_ACCESS_KEY
npx wrangler secret put R2_MAIN_SECRET_KEY
```

Notes:

- `endpoint` and `secret_ref` are **both required** for every backend — streaming and scanning
  resolve credentials from them (`src/shared/backends.ts`). A row missing either fails loudly
  rather than silently serving nothing.
- `type='r2'` here means R2 reached via its **S3-compatible endpoint** (with `endpoint` +
  `secret_ref`), which is the supported path in v1. The alternative R2 *bucket-binding* path
  (`type='r2'` with **no** endpoint) is stubbed but not wired — `resolveS3Config` rejects a
  missing endpoint — so always give R2 an endpoint.
- You can add several backends; the lowest `priority` number wins when more than one holds the same
  track.

---

## 7. Deploy

```sh
npm run deploy
```

This runs `wrangler deploy` and publishes the `stratum` Worker (name from `wrangler.jsonc`),
including the one-minute cron trigger.

Once deployed, the **cron importer runs every minute automatically** (no external driver). Each
tick:

1. Advances enumeration by one list page per enabled backend (resumable via `meta` cursors), then
2. Ingests a bounded batch of pending files — reading each file's header via an S3 Range GET,
   parsing FLAC/MP3 tags, and upserting artists/albums/tracks.

The **one-time backfill is paced per tick**: each tick issues one list request per enabled backend
(scan) plus a bounded ingest batch — up to ~20 files, and at most ~45 external S3 requests per
invocation. (It is the *ingest* batch that is hard-capped; scan issues one list request per enabled
backend, so with a normal handful of backends the whole tick stays well within the Workers free
tier.) A large library therefore fills in over many ticks rather than all at once. It's resumable:
a killed tick simply leaves its work pending for the next minute. You can watch progress with
`getScanStatus` (§10).

---

## 8. Create your first real user

Use the **bootstrap admin** (`ADMIN_USERNAME` / `ADMIN_PASSWORD`) to call `createUser`. The admin
works even though no user rows exist yet. Replace `<ADMIN_PASSWORD>` with the secret you set in §5
and the host with your Worker URL:

```sh
curl "https://stratum.<your-subdomain>.workers.dev/rest/createUser?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=setup&f=json&username=alice&password=s3cret&email=alice@example.com"
```

`createUser` requires admin auth and the `username` + `password` parameters; `email` and
`adminRole=true` are optional. A new user is automatically issued an `api_key` (for OpenSubsonic
apiKey auth).

**How clients then authenticate** (any of):

- **Token auth (recommended for Subsonic clients):** the client sends `u`, a random salt `s`, and
  `t = MD5(password + s)`.
- **OpenSubsonic apiKey auth:** the client sends `apiKey=<the user's api_key>` (no username needed).
- **Legacy password:** `p=<plaintext>` or `p=enc:<hex>`.

Point your Subsonic client (Symfonium, Amperfy, DSub, …) at
`https://stratum.<your-subdomain>.workers.dev`, username `alice`, password `s3cret`.

> Every Subsonic method — including `ping` — requires valid authentication; there are no public
> endpoints.

---

## 9. Exposing a home Garage/MinIO with a Cloudflare Tunnel

**Why this is necessary.** Stratum streams by presigning a GET URL and **302-redirecting the
client straight to the storage endpoint** — the Worker never proxies the bytes. SigV4 presigning
binds the signature to a specific host, so the presigned URL uses the **same hostname stored in the
backend row's `endpoint`**. Therefore that hostname must be reachable:

> **by both the Cloudflare Worker and by your client devices, at the same public URL.**

A private LAN address (`http://192.168.x.x:3900`) can't satisfy this. Expose the server with a
**Cloudflare Tunnel** instead — it's outbound-only, so you forward **no inbound ports** and your
router stays closed. Keep the bucket **private** (reads require credentials) so that only holders of
a valid presigned URL can read it: Stratum signs the URLs, but denying unsigned or public access is
enforced by your storage server's access policy, not by the tunnel.

Conceptual steps (see the
[Cloudflare Tunnel docs](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)
for exact commands):

1. Install `cloudflared` on the machine that runs Garage/MinIO and authenticate it to your
   Cloudflare account.
2. Create a tunnel and **route a public hostname** (e.g. `music.example.com`, on a domain in your
   Cloudflare account) to the local S3 API — for Garage typically `http://localhost:3900`.
3. Start the tunnel (or install it as a service). It dials out to Cloudflare; nothing listens for
   inbound connections on your network.
4. Set that public hostname as the backend's `endpoint` in `storage_backends` (as in §6):
   `https://music.example.com`. Make sure `region` is `auto` (or whatever your server expects) and
   the bucket/credentials are correct.

Now both the importer (from the Worker) and clients (from anywhere) reach the bucket at
`https://music.example.com`, and — with a private bucket — only correctly signed, short-lived GETs
are honored.

> Public providers (R2, B2, AWS S3) need none of this — their endpoints are already public
> hostnames. R2 additionally has **zero egress fees**, which is ideal here since clients download
> audio directly from storage.

---

## 10. Smoke test

With the Worker deployed and a user created, verify the API answers. Using the bootstrap admin:

```sh
# Liveness — expect an "ok" subsonic-response envelope.
curl "https://stratum.<your-subdomain>.workers.dev/rest/ping?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=smoke&f=json"

# Importer / library progress — scanning=true while files are still queued; count = ingested tracks.
curl "https://stratum.<your-subdomain>.workers.dev/rest/getScanStatus?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=smoke&f=json"

# Browse — once the importer has ingested some tracks, this lists your artists.
curl "https://stratum.<your-subdomain>.workers.dev/rest/getArtists?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=smoke&f=json"
```

If `getScanStatus` shows `scanning: true` with a `count` that climbs each minute, the cron importer
is working. To force a fresh re-enumeration of every backend (e.g. after adding files), call
`startScan` as admin — it clears the importer's per-backend completion flags so the next cron tick
rescans:

```sh
curl "https://stratum.<your-subdomain>.workers.dev/rest/startScan?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=smoke&f=json"
```

---

## Troubleshooting

- **`Streaming backend not available` on `stream`/`getCoverArt`:** the backend's secrets aren't
  set, or its `secret_ref` doesn't match the secret names. Confirm `<SECRET_REF>_ACCESS_KEY` /
  `<SECRET_REF>_SECRET_KEY` exist and the prefix matches the row's `secret_ref`.
- **Client plays metadata but audio won't load:** almost always a reachability problem (§9). The
  client must be able to reach the backend `endpoint` hostname directly. Try opening a presigned URL
  from the client's network.
- **`getScanStatus` count stays at 0:** check the backend `endpoint`/`bucket`/credentials and that
  `enabled = 1`; the importer logs each tick (Workers observability is enabled in `wrangler.jsonc`).
- **Nothing ingested from certain files:** only `flac` and `mp3` get tag parsing; `m4a`/`aac`/`ogg`/
  `opus`/`wav` are indexed with path-derived metadata, and non-audio keys are skipped entirely.
