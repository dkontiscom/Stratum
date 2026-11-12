-- Stratum D1 schema (v1)
-- SPDX-License-Identifier: MIT
--
-- Design notes:
--  * ONE id contract, shared by server + importer (src/shared): ids are a hash of a
--    normalized string. Never regenerate them differently anywhere, or stars/playlists
--    (which reference ids) break.
--      artist_id = hash("artist:" + normalizedArtistName)
--      album_id  = hash("album:"  + normalizedArtistName + ":" + normalizedAlbumName)
--      track_id  = hash("track:"  + normalizedPathStem)   -- folder + basename, NO extension
--    The track_id is path-stem based so a later 01.mp3 beside 01.flac maps to the SAME track.
--  * Audio file locations live in `track_files` (one track -> many files: formats/tiers/backends),
--    NOT on `tracks`. `tracks` keeps a denormalized copy of the ORIGINAL file's suffix/bitrate/size
--    for the default Subsonic response.
--  * Per-user state (stars, ratings) lives in `annotations`. Global play stats live on the item
--    rows (simpler; fine for the frequent/recent lists at personal scale).
--  * Storage credentials are NOT stored here — only a `secret_ref` naming the Cloudflare secret.
--  * Enrichment columns are limited to what the Subsonic/OpenSubsonic API actually serves. An
--    enrich() addon fills these same columns; it does not add service-specific ones.

-- ── Storage backends (admin-configured; multiple, each with a role) ──────────────────────────
CREATE TABLE IF NOT EXISTS storage_backends (
  id          TEXT PRIMARY KEY,            -- short stable id, e.g. 'garage-home'
  name        TEXT NOT NULL,
  type        TEXT NOT NULL,               -- 'r2' | 's3' | 'garage' | 'b2'
  endpoint    TEXT,                        -- base URL (null for R2-binding type)
  region      TEXT,
  bucket      TEXT NOT NULL,
  role        TEXT NOT NULL DEFAULT 'primary', -- 'primary' | 'fast' | 'backup' | 'lowq'
  priority    INTEGER NOT NULL DEFAULT 100,     -- lower = preferred when several hold the same track
  secret_ref  TEXT,                        -- prefix naming the CF secrets, e.g. 'GARAGE_HOME' ->
                                           --   GARAGE_HOME_ACCESS_KEY / GARAGE_HOME_SECRET_KEY
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Library core ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS artists (
  id            TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  sort_name     TEXT,
  -- enrichment (getArtistInfo2): all optional, filled by importer or an enrich() addon
  biography     TEXT,
  image_url     TEXT,                      -- external image URL (artist art)
  mbz_artist_id TEXT,
  lastfm_url    TEXT,
  similar_json  TEXT,                      -- JSON array of {id?,name} for similarArtist
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS albums (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  sort_name       TEXT,
  artist_id       TEXT NOT NULL REFERENCES artists(id),
  artist_name     TEXT NOT NULL,           -- denormalized for cheap responses
  year            INTEGER,
  genre           TEXT,
  -- cover art: a file in some backend (coverArt id = album id by convention)
  cover_backend_id TEXT REFERENCES storage_backends(id),
  cover_key       TEXT,
  -- global play stats (drive getAlbumList type=newest/recent/frequent)
  song_count      INTEGER NOT NULL DEFAULT 0,
  duration        INTEGER NOT NULL DEFAULT 0,
  play_count      INTEGER NOT NULL DEFAULT 0,
  last_played_at  TEXT,
  -- enrichment (getAlbumInfo2): optional
  notes           TEXT,
  mbz_release_id  TEXT,
  release_date    TEXT,
  record_label    TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS tracks (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  sort_title      TEXT,
  album_id        TEXT NOT NULL REFERENCES albums(id),
  album_name      TEXT NOT NULL,           -- denormalized
  artist_id       TEXT NOT NULL REFERENCES artists(id),
  artist_name     TEXT NOT NULL,           -- denormalized
  track_number    INTEGER,
  disc_number     INTEGER DEFAULT 1,
  year            INTEGER,
  genre           TEXT,
  duration        INTEGER NOT NULL DEFAULT 0,  -- seconds; same across formats
  -- denormalized ORIGINAL-file properties for the default Subsonic song response
  suffix          TEXT,
  content_type    TEXT,
  bit_rate        INTEGER,
  size            INTEGER,
  -- global play stats
  play_count      INTEGER NOT NULL DEFAULT 0,
  last_played_at  TEXT,
  -- enrichment: optional
  bpm             INTEGER,
  isrc            TEXT,
  mbz_recording_id TEXT,
  lyrics          TEXT,                     -- plain unsynced lyrics (getLyrics / getLyricsBySongId)
  created_at      TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Audio files (one track -> many files) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS track_files (
  id          TEXT PRIMARY KEY,            -- hash(backend_id + ':' + key)
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  backend_id  TEXT NOT NULL REFERENCES storage_backends(id),
  key         TEXT NOT NULL,               -- object key within the backend's bucket
  format      TEXT NOT NULL,               -- suffix: 'flac' | 'mp3' | ...
  bitrate     INTEGER,                     -- kbps
  size        INTEGER,                     -- bytes (also used for importer skip-if-same-size)
  is_original INTEGER NOT NULL DEFAULT 1,  -- the source file (download endpoint returns this)
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (backend_id, key)
);

-- ── Playlists ──────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS playlists (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  comment     TEXT,
  owner       TEXT NOT NULL DEFAULT 'admin',
  public      INTEGER NOT NULL DEFAULT 0,
  song_count  INTEGER NOT NULL DEFAULT 0,
  duration    INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS playlist_tracks (
  playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  PRIMARY KEY (playlist_id, position)
);

-- ── Users ────────────────────────────────────────────────────────────────────────────────────
-- NOTE: `password` is stored as recoverable plaintext. This is forced by Subsonic token auth
-- (t = MD5(password + salt)); the server must know the original to verify. Not a mistake.
CREATE TABLE IF NOT EXISTS users (
  id          TEXT PRIMARY KEY,
  username    TEXT NOT NULL UNIQUE,
  password    TEXT NOT NULL,
  email       TEXT,
  is_admin    INTEGER NOT NULL DEFAULT 0,
  api_key     TEXT,                        -- OpenSubsonic apiKey auth (revocable per user)
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Per-user annotations (stars + ratings) ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS annotations (
  user        TEXT NOT NULL,
  item_type   TEXT NOT NULL,               -- 'track' | 'album' | 'artist'
  item_id     TEXT NOT NULL,
  starred_at  TEXT,                         -- null = not starred
  rating      INTEGER,                      -- 1..5, null = unrated
  PRIMARY KEY (user, item_type, item_id)
);

-- ── Play history (scrobble log) ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_history (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  user      TEXT NOT NULL,
  track_id  TEXT NOT NULL REFERENCES tracks(id),
  played_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Now playing (live state, NOT history) ───────────────────────────────────────
-- One row per user: what they are currently playing. Upserted on every scrobble (both
-- the submission=false "now playing" ping and the submission=true completed play).
-- getNowPlaying reads this within a short freshness window. Kept separate from
-- play_history so now-playing pings never pollute the completed-play log.
CREATE TABLE IF NOT EXISTS now_playing (
  user       TEXT PRIMARY KEY,
  track_id   TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  player     TEXT,                          -- client name (Subsonic `c` param)
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Bookmarks ────────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS bookmarks (
  user        TEXT NOT NULL,
  track_id    TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL DEFAULT 0,   -- milliseconds
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  changed_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user, track_id)
);

-- ── Play queue (saved per user) ────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS play_queue_state (
  user             TEXT PRIMARY KEY,
  current_track_id TEXT,
  current_position INTEGER NOT NULL DEFAULT 0, -- milliseconds
  changed_at       TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS play_queue_items (
  user      TEXT NOT NULL,
  track_id  TEXT NOT NULL REFERENCES tracks(id) ON DELETE CASCADE,
  position  INTEGER NOT NULL,
  PRIMARY KEY (user, position)
);

-- ── Internet radio ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS internet_radio_stations (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  stream_url   TEXT NOT NULL,
  homepage_url TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ── Importer worklist (resume state + retry log) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS import_worklist (
  backend_id  TEXT NOT NULL REFERENCES storage_backends(id),
  key         TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'done' | 'error' | 'skip'
  error       TEXT,
  size        INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (backend_id, key)
);

-- ── Misc key/value (enumeration cursors, schema version, etc.) ──────────────────────────────────
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- ── Indexes ──────────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_albums_artist      ON albums(artist_id);
CREATE INDEX IF NOT EXISTS idx_tracks_album        ON tracks(album_id);
CREATE INDEX IF NOT EXISTS idx_tracks_artist       ON tracks(artist_id);
CREATE INDEX IF NOT EXISTS idx_track_files_track   ON track_files(track_id);
CREATE INDEX IF NOT EXISTS idx_annotations_star    ON annotations(user, item_type, starred_at);
CREATE INDEX IF NOT EXISTS idx_play_history_user   ON play_history(user, played_at);
CREATE INDEX IF NOT EXISTS idx_worklist_status     ON import_worklist(status);
CREATE INDEX IF NOT EXISTS idx_albums_newest       ON albums(created_at);
CREATE INDEX IF NOT EXISTS idx_albums_frequent     ON albums(play_count);
