// SPDX-License-Identifier: MIT
// Shared types: the Worker Env and D1 row shapes. Row types mirror schema/schema.sql.

/**
 * Worker environment. Beyond the D1 binding and a bootstrap admin, storage credentials are
 * dynamic: each storage_backends row names a `secret_ref` (e.g. "GARAGE_HOME"), and we read
 * `GARAGE_HOME_ACCESS_KEY` / `GARAGE_HOME_SECRET_KEY` from here. R2 backends may instead expose
 * an R2 bucket binding by the same ref. Hence the index signature.
 */
export interface Env {
  DB: D1Database;
  ADMIN_USERNAME?: string;
  ADMIN_PASSWORD?: string;
  // dynamic: `${secret_ref}_ACCESS_KEY`, `${secret_ref}_SECRET_KEY`, or an R2 bucket binding.
  [binding: string]: unknown;
}

export interface StorageBackendRow {
  id: string;
  name: string;
  type: "r2" | "s3" | "garage" | "b2";
  endpoint: string | null;
  region: string | null;
  bucket: string;
  role: "primary" | "fast" | "backup" | "lowq";
  priority: number;
  secret_ref: string | null;
  enabled: number;
}

export interface ArtistRow {
  id: string;
  name: string;
  sort_name: string | null;
  biography: string | null;
  image_url: string | null;
  mbz_artist_id: string | null;
  lastfm_url: string | null;
  similar_json: string | null;
}

export interface AlbumRow {
  id: string;
  name: string;
  sort_name: string | null;
  artist_id: string;
  artist_name: string;
  year: number | null;
  genre: string | null;
  cover_backend_id: string | null;
  cover_key: string | null;
  song_count: number;
  duration: number;
  play_count: number;
  last_played_at: string | null;
  notes: string | null;
  mbz_release_id: string | null;
  release_date: string | null;
  record_label: string | null;
}

export interface TrackRow {
  id: string;
  title: string;
  sort_title: string | null;
  album_id: string;
  album_name: string;
  artist_id: string;
  artist_name: string;
  track_number: number | null;
  disc_number: number | null;
  year: number | null;
  genre: string | null;
  duration: number;
  suffix: string | null;
  content_type: string | null;
  bit_rate: number | null;
  size: number | null;
  play_count: number;
  last_played_at: string | null;
  bpm: number | null;
  isrc: string | null;
  mbz_recording_id: string | null;
  lyrics: string | null;
}

export interface TrackFileRow {
  id: string;
  track_id: string;
  backend_id: string;
  key: string;
  format: string;
  bitrate: number | null;
  size: number | null;
  is_original: number;
}

/** Tags extracted by a parser (importer). All optional except what the file yields. */
export interface AudioTags {
  artist?: string;
  albumArtist?: string;
  album?: string;
  title?: string;
  trackNo?: number;
  discNo?: number;
  year?: number;
  genre?: string;
  durationSec?: number;
  bitrateKbps?: number;
}
