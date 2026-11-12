# Stratum v1 Plan

**Goal:** a clean, public, open-source OpenSubsonic/Subsonic server that runs on Cloudflare
Workers + D1, serving audio from admin-configured S3-compatible storage. Built as a portfolio
case study (edge architecture; "don't reinvent the wheel"). No Sulcus, no Mac stack, no Soulseek.

**Repo layout:** one clean public repo = **Stratum (server)** + **Importer (parser)**.
Sulcus and the old Mac stack (slskd/soulsync/sync/webhook/StratumApp) live in separate PRIVATE
repos. The public repo is created fresh (no inherited git history containing the Soulseek stack).

## Free-tier note (personal use, ~10k songs)
Free on Cloudflare **provided the audio lives on self-hosted Garage (your disk)**, reached via a
free Cloudflare Tunnel. R2 free storage is only 10 GB — far too small for ~300 GB of FLAC — so R2
is optional as a small fast/low-bitrate tier, not the bulk store. D1 + Workers + serving are
comfortably within free limits at this scale. One-time backfill from Garage hits the 50-subrequest
throttle (~4 h, hands-off via cron); incremental runs afterward are tiny.

## 1. Schema (foundation — do first)
- Reconcile `schema.sql` to match the code (fix the drift: the repo currently can't deploy a
  working server — missing tables `bookmarks`, `play_queue`, `internet_radio_stations` and ~25
  columns). See [[stratum-known-issues]].
- New **`storage_backends`** table: `{id, type(r2|s3|garage|b2), endpoint, region, bucket,
  role(primary|fast|backup|lowq), priority}`. Access keys held as CF secrets, referenced by row.
- New **`track_files`** child table: `{track_id, backend_id, key, format, bitrate, size}` —
  replaces the single `tracks.path`. One track → many files (formats/tiers/backends).
- Drop vestigial `NAVIDROME_URL` / `NAVIDROME_PASS` / `MUSIC` (R2) from the `Env` interface.
- **One ID contract, owned by the importer:** `track_id = hash(normalized path stem)` (folder +
  basename without extension), so a future `01.mp3` beside `01.flac` maps to the same track.
  Server and importer call the SAME id function → eliminates the current dual-ID divergence.

## 2. Importer v1 (Cloudflare Worker + Cron + D1 worklist)
- **Enumerate** each configured backend (ListObjectsV2 / R2 binding) → insert audio keys into a
  worklist table as `status='pending'`.
- **Cron batches:** `SELECT ... WHERE status='pending' LIMIT ~20` → range-read + parse → write
  `track_files` + artist/album/track rows → flip to `done`. Failures stay `pending` (auto-retry).
  The worklist IS the resume state and retry log.
- **Parser v1: FLAC + MP3 only.** Header-walk (do NOT assume a fixed byte window — skip large
  PICTURE blocks, targeted range read for VORBIS_COMMENT). Compute duration
  (FLAC STREAMINFO; MP3 Xing/Info header for VBR, else `size*8/bitrate` for CBR).
- **Register EXISTING files only** — no transcoding, no tier placement (can't transcode in a
  Worker anyway). Cover art = record the key.
- **One enrichment hook** (interface only): `enrich(parsedTrack) -> fields`. No plugin *system*
  yet; identification/enrichment addons (MusicBrainz/Discogs; soulsync in the private Sulcus repo)
  implement this later. Keeps the public repo piracy-free by construction.
- Idempotent upserts (`ON CONFLICT DO UPDATE`).

## 3. Server fixes
- `stream` selects the right `track_files` row by requested `format` / `maxBitRate`, signs against
  that row's backend, 302-redirects. (Still effectively FLAC-only until a transcode addon exists,
  but the selection logic is in place.)
- `getCoverArt` serves from the recorded cover key.
- Fix known bugs: loop inserts → chunked batch (`createPlaylist`/`updatePlaylist`/`savePlayQueue`);
  `getAlbumList2?type=byYear` SQL injection → bind params; `playlists.is_public` vs `public`;
  `f=jsonp` callback wrapper; `albumCount` real count instead of hardcoded 0.

## 4. Config
- Secrets (storage access/secret keys) → **Cloudflare Worker secrets**.
- Simple scalars (admin username, API version) → `wrangler.jsonc` `vars`.
- Multi-backend storage config → **D1 `storage_backends` table** (seed via `wrangler d1 execute`).
- **No web UI.** Importer is a Worker (cron + worklist); admin edits D1 directly for now.

## 5. Tests
- Parser unit tests with byte fixtures (FLAC, MP3).
- Seeded-D1 smoke test per endpoint group (browse / stream / search / playlist / auth).

## 6. Explicitly OUT of v1 (scope guardrails)
Transcoding + tier placement · plugin *system* (only the hook exists) · M4A / OGG / WAV parsing ·
admin UI · federation / sharing · Sulcus · any homegrown music-ID engine.
