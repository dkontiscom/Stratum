# Stratum

A self-hosted **OpenSubsonic / Subsonic** music server that runs entirely on **Cloudflare
Workers + D1**, streaming audio from any S3-compatible storage you control. Speaks the Subsonic
API, so it works with existing Subsonic client apps (Symfonium, Amperfy, DSub, play:Sub, …).

- **Server** (`fetch`): answers the Subsonic API from D1; audio is served by 302-redirecting the
  client to a short-lived presigned URL — the Worker never proxies audio bytes.
- **Importer** (`scheduled`): scans your storage on a one-minute cron, reads tags, and writes the
  library into D1. Resumable, batched, free-tier friendly.
- **Storage**: admin-configured, multiple S3-compatible backends at once (Garage, MinIO, R2, B2,
  AWS S3), each tagged with a role (primary / fast / backup / low-quality).

> **Status: v1 — feature-complete and unit-tested (122 passing tests); first production deploy
> pending.** Every Subsonic method listed below is implemented and registered; the 122-test
> suite under `test/` covers behavior across the API (auth, browsing, search, annotations,
> playlists, streaming, importer, users, radio, scan), though not every individual method has a
> dedicated test. Stratum has not yet been run against a live Cloudflare account or verified
> end-to-end with a real Subsonic client app. Treat it as a working, reviewable v1, not a
> battle-tested release.

## What it is

Stratum is one Cloudflare Worker that implements the [OpenSubsonic](https://opensubsonic.netlify.app/)
/ Subsonic REST API on top of:

- **D1** (Cloudflare's SQLite) as the library database — artists, albums, tracks, playlists,
  users, annotations, play history, bookmarks, radio stations, and the importer's worklist.
- **S3-compatible object storage** for the actual audio files. You keep your music wherever you
  like (a home Garage or MinIO, Cloudflare R2, Backblaze B2, AWS S3); Stratum only stores
  *pointers* to the objects, never the audio.

Because it speaks the Subsonic API, you point any Subsonic-compatible client at your Worker's
URL and browse/stream your own library.

## Architecture

One Worker, two entry points (see `src/index.ts`):

| Entry point | Trigger | Job |
|-------------|---------|-----|
| `fetch`     | HTTP requests to `/rest/*` | Serve the Subsonic API from D1 (`src/server`). |
| `scheduled` | Cron `* * * * *` (every minute) | Run one bounded importer batch (`src/importer`). |

**Presign-and-redirect streaming.** The Worker *never* streams audio bytes through itself. For
`stream` and `download`, it resolves the track to a physical object in one of your backends,
generates a short-lived (default **one hour**) SigV4 **presigned GET URL**, and returns a **302
redirect** to it (`src/server/handlers/streaming.ts`). `getCoverArt` works the same for album
covers, but instead redirects straight to an artist's image URL when that's what is set, and
returns a not-found error when there is no art. The client then fetches the bytes — and makes its
own HTTP Range requests — **directly against your storage endpoint**. This keeps the Worker cheap
and fast and sidesteps Workers' CPU/response limits, but it has an important consequence for
storage reachability (see below).

**Multi-backend storage with roles.** Backends live in the D1 `storage_backends` table, not in
config. Each row has a `type` (`r2` | `s3` | `garage` | `b2`), a `role`
(`primary` | `fast` | `backup` | `lowq`), and a numeric `priority` (lower = preferred). A single
track can have files on several backends (different formats/tiers); when streaming, Stratum picks
the best file by *original-first → backend priority → format rank (flac > mp3 > other)*.

**Credentials by convention.** Storage secrets are **not** stored in D1. Each backend row names a
`secret_ref` (e.g. `GARAGE_HOME`), and the Worker reads `GARAGE_HOME_ACCESS_KEY` /
`GARAGE_HOME_SECRET_KEY` from its secrets at request time (`src/shared/backends.ts`,
`src/shared/types.ts`). Only the `secret_ref` prefix is ever persisted.

## Features / API coverage

All of the following Subsonic / OpenSubsonic methods are implemented and registered in
`src/server/router.ts`:

- **System / handshake:** `ping`, `getLicense`, `getOpenSubsonicExtensions`.
- **Browsing:** `getMusicFolders`, `getIndexes`, `getMusicDirectory`, `getArtists`, `getArtist`,
  `getArtistInfo2`, `getAlbum`, `getAlbumInfo2`, `getAlbumList`, `getAlbumList2`, `getSong`,
  `getGenres`, `getSongsByGenre`, `getRandomSongs`.
- **Search:** `search2`, `search3`.
- **Media retrieval (302 redirect to storage):** `stream`, `download`, `getCoverArt`.
- **Annotations:** `star`, `unstar`, `setRating`, `scrobble`, `playbackReport`.
- **Personal lists / lyrics:** `getStarred`, `getStarred2`, `getNowPlaying`, `getTopSongs`,
  `getSimilarSongs`, `getSimilarSongs2`, `getLyrics`, `getLyricsBySongId`.
- **Playlists:** `getPlaylists`, `getPlaylist`, `createPlaylist`, `updatePlaylist`,
  `deletePlaylist`.
- **Play queue / bookmarks:** `savePlayQueue`, `getPlayQueue`, `createBookmark`, `getBookmarks`,
  `deleteBookmark`.
- **User management (admin-gated except self-view / self-changePassword):** `getUser`, `getUsers`,
  `createUser`, `updateUser`, `deleteUser`, `changePassword`, `getAvatar`.
- **Internet radio (reads open; mutations admin-only):** `getInternetRadioStations`,
  `createInternetRadioStation`, `updateInternetRadioStation`, `deleteInternetRadioStation`.
- **Library scan (wired to the cron importer):** `getScanStatus`, `startScan`.

**Response formats:** XML, JSON, and JSONP (via `f`), with the OpenSubsonic envelope fields
(`type`, `serverVersion`, `openSubsonic`) on every response. **Authentication:** three
mechanisms (OpenSubsonic `apiKey`; Subsonic token auth `u` + `t`=MD5(password+`s`) + salt `s`;
legacy `p` plaintext/`enc:`), plus a bootstrap admin that works before any user row exists.
**OpenSubsonic extensions advertised:** `formPost`, `songLyrics`, `apiKeyAuthentication`,
`transcodeOffset`, `playbackReport`, `songSimilarity`, `indexBasedQueue`.

**Tag parsing:** the importer reads tags from **FLAC** and **MP3** files only. Other audio
extensions it recognizes (`m4a`, `aac`, `ogg`, `opus`, `wav`) are still indexed and streamable,
but with metadata derived from the file path/name rather than embedded tags.

## Quickstart

This is the short version; the full operator walkthrough — including the home-storage tunnel — is
in **[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)**.

```sh
npm install

# 1. Create the D1 database, then paste the returned database_id into wrangler.jsonc.
npx wrangler d1 create stratum-db

# 2. Load the schema (remote = your real D1; use --local for `npm run dev`).
npx wrangler d1 execute stratum-db --remote --file=./schema/schema.sql

# 3. Set the bootstrap admin password and per-backend storage credentials.
npx wrangler secret put ADMIN_PASSWORD
npx wrangler secret put GARAGE_HOME_ACCESS_KEY
npx wrangler secret put GARAGE_HOME_SECRET_KEY

# 4. Seed a storage backend row (real columns; see DEPLOYMENT.md for a full example).
npx wrangler d1 execute stratum-db --remote --command \
  "INSERT INTO storage_backends (id, name, type, endpoint, region, bucket, role, priority, secret_ref, enabled) \
   VALUES ('garage-home','Home Garage','garage','https://music.example.com','auto','music','primary',100,'GARAGE_HOME',1)"

# 5. Deploy. The cron importer begins scanning + ingesting automatically.
npm run deploy

# 6. Create your first real user via the bootstrap admin, then point a Subsonic client at the Worker URL.
curl "https://stratum.<your-subdomain>.workers.dev/rest/createUser?u=admin&p=<ADMIN_PASSWORD>&v=1.16.1&c=setup&f=json&username=alice&password=s3cret"
```

The non-secret defaults live in `wrangler.jsonc` (`ADMIN_USERNAME=admin`, `SERVER_NAME=stratum`,
`SUBSONIC_API_VERSION=1.16.1`).

## Storage reachability (read this before choosing storage)

Streaming works by **presigning a URL and 302-redirecting the client to it**. That means the
*client app* — the phone or desktop running Symfonium/Amperfy/etc. — connects to your storage
endpoint directly to pull the audio. And because SigV4 presigning binds the signature to a
specific host, the presigned URL uses the **same hostname the importer uses** (the backend row's
`endpoint`). So the rule is:

> **Every storage endpoint must be reachable, at the same public hostname, by both the Cloudflare
> Worker and by your client devices.**

What this means in practice:

- **Public S3 / R2 / B2 → no tunnel needed.** Their endpoints are already public hostnames
  reachable from anywhere; once the backend row and credentials are configured, there is no extra
  network setup. (**R2 is the best pairing: zero egress fees**, so the direct client downloads cost
  you nothing in bandwidth.)
- **A home Garage or MinIO → must be exposed at a public hostname.** A private LAN address like
  `http://192.168.1.10:3900` cannot be reached by Cloudflare *or* by clients off your network, and
  presigning against it would hand clients an unreachable URL.

The recommended way to expose a home server is a **[Cloudflare Tunnel](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/)**
(`cloudflared`): it publishes your local Garage/MinIO at a public hostname (e.g.
`https://music.example.com`) which you then use as the backend's `endpoint`. The tunnel is
**outbound-only** — your home router stays fully closed, with no inbound ports forwarded. Keep the
bucket **private** (reads require credentials): Stratum hands clients short-lived presigned URLs,
and your storage server's own access policy is what denies unsigned or public requests.
`docs/DEPLOYMENT.md` has the step-by-step tunnel setup.

## Development

```sh
npm test          # run the test suite (vitest, 122 tests)
npm run typecheck  # tsc --noEmit
npm run dev        # local Worker via `wrangler dev` (use schema with --local)
```

## Project layout

```
src/
  index.ts            Worker entry: fetch (API) + scheduled (importer cron)
  shared/             Env/row types, ID contract, S3 SigV4 (presign/list/range), backends, media helpers
  server/             Subsonic API — router, auth, response envelopes, and handlers/ per method group
  importer/           Cron importer — scan (enumerate) + ingest (parse & upsert), parsers/ (flac, mp3)
schema/
  schema.sql          D1 schema (storage_backends, library, users, annotations, worklist, …)
test/                 Vitest suites (122 tests) over API, auth, importer, parsers, playlists, users, …
```

## Scope / limitations (v1)

- **No server-side transcoding.** Stratum always serves the original file; `stream`'s
  `maxBitRate`, `format`, and `estimateContentLength` parameters are deliberately ignored (there is
  no ffmpeg on a Worker). Clients that can play your source formats work directly; on-the-fly
  transcoding is out of scope for v1.
- **No admin web UI yet.** Administration is done through the Subsonic user-management API
  (`createUser`, `updateUser`, …) or by editing D1 directly. An Access-gated admin console is
  planned for v1.1.
- **FLAC + MP3 tag parsing only.** Other audio files are indexed and streamable but carry only
  path-derived metadata.
- **No cover-art extraction yet.** The importer does not currently populate album covers;
  `getCoverArt` serves covers only once an album's `cover_backend_id`/`cover_key` (or an artist
  `image_url`) is set.
- **No federation or sharing** (no `createShare`/`getShares`, no multi-server sync).
- The `r2` backend *binding* path (R2 bucket binding instead of SigV4) is stubbed but not wired in
  v1; use R2 via its S3-compatible endpoint with a `secret_ref` like any other backend.

## License

MIT
