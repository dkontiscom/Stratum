// SPDX-License-Identifier: MIT
//
// INGEST stage: take a batch of 'pending' worklist rows, read each file's header from storage,
// parse tags, and upsert artists / albums / tracks / track_files through the shared ID contract.
// Each file's writes go in ONE D1 batch (atomic), and the worklist row is only marked 'done'
// after a successful write — so a tick that dies mid-way just leaves the row pending to retry.
// This is the "knows where it left off" guarantee.

import type { Env, StorageBackendRow, AudioTags } from "../shared/types";
import { getBackend, resolveS3Config } from "../shared/backends";
import { getRange, type S3Config } from "../shared/s3";
import { extOf, ext2mime } from "../shared/media";
import { artistId, albumId, trackId, trackFileId } from "../shared/ids";
import { parseTags, HEADER_BYTES } from "./parsers";
import { setMeta } from "./scan";

interface PendingRow {
  backend_id: string;
  key: string;
  size: number | null;
}

/** Last-resort metadata from the object key: Artist/Album/NN - Title.ext */
function fromFilename(key: string): { artist?: string; album?: string; title?: string; trackNo?: number } {
  const segs = key.replace(/^\/+/, "").split("/");
  const base = segs[segs.length - 1] ?? "";
  const stem = base.replace(/\.[^.]+$/, "");
  const trackNo = stem.match(/^\s*(\d{1,3})\b/)?.[1];
  const title = stem.replace(/^\s*\d{1,3}\s*[-._)]*\s*/, "").trim() || stem;
  return {
    artist: segs.length >= 3 ? segs[segs.length - 3] : undefined,
    album: segs.length >= 2 ? segs[segs.length - 2] : undefined,
    title,
    trackNo: trackNo ? parseInt(trackNo, 10) : undefined,
  };
}

/** Format preference for the track's denormalized "original" fields (higher = better). */
function formatRank(ext: string): number {
  return ext === "flac" ? 3 : ext === "mp3" ? 2 : 1;
}

/** Build the atomic write for one file. Returns the D1 statements in execution order. */
async function buildWrites(env: Env, row: PendingRow, ext: string, tags: AudioTags) {
  const fn = fromFilename(row.key);
  const albumArtistName = (tags.albumArtist || tags.artist || fn.artist || "Unknown Artist").trim();
  const trackArtistName = (tags.artist || albumArtistName).trim();
  const albumName = (tags.album || fn.album || "Unknown Album").trim();
  const title = (tags.title || fn.title || "Untitled").trim();

  const aAlbumArtist = await artistId(albumArtistName);
  const aTrackArtist = await artistId(trackArtistName);
  const idAlbum = await albumId(albumArtistName, albumName);
  const idTrack = await trackId(row.key);
  const idFile = await trackFileId(row.backend_id, row.key);

  const year = tags.year ?? null;
  const genre = tags.genre ?? null;
  const duration = tags.durationSec ?? 0;
  const bitrate = tags.bitrateKbps ?? null;
  const size = row.size ?? null;
  const rank = formatRank(ext);

  const stmts = [
    env.DB.prepare("INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)").bind(aAlbumArtist, albumArtistName),
    env.DB.prepare("INSERT OR IGNORE INTO artists (id, name) VALUES (?, ?)").bind(aTrackArtist, trackArtistName),

    env.DB.prepare(
      `INSERT INTO albums (id, name, artist_id, artist_name, year, genre)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, artist_name = excluded.artist_name,
         year = COALESCE(albums.year, excluded.year),
         genre = COALESCE(albums.genre, excluded.genre),
         updated_at = datetime('now')`
    ).bind(idAlbum, albumName, aAlbumArtist, albumArtistName, year, genre),

    // Track metadata is always refreshed. The denormalized suffix/content_type/bit_rate/size are
    // set on first insert, then left alone here — a dedicated UPDATE below keeps them pointing at
    // the BEST available format so a later low-quality copy never clobbers the FLAC's numbers.
    env.DB.prepare(
      `INSERT INTO tracks
         (id, title, album_id, album_name, artist_id, artist_name,
          track_number, disc_number, year, genre, duration, suffix, content_type, bit_rate, size)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title, album_id = excluded.album_id, album_name = excluded.album_name,
         artist_id = excluded.artist_id, artist_name = excluded.artist_name,
         track_number = excluded.track_number, disc_number = excluded.disc_number,
         year = excluded.year, genre = excluded.genre,
         duration = CASE WHEN excluded.duration > 0 THEN excluded.duration ELSE tracks.duration END,
         updated_at = datetime('now')`
    ).bind(
      idTrack, title, idAlbum, albumName, aTrackArtist, trackArtistName,
      tags.trackNo ?? fn.trackNo ?? null, tags.discNo ?? null, year, genre,
      duration, ext, ext2mime(ext), bitrate, size
    ),

    env.DB.prepare(
      `INSERT INTO track_files (id, track_id, backend_id, key, format, bitrate, size, is_original)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET
         track_id = excluded.track_id, format = excluded.format,
         bitrate = excluded.bitrate, size = excluded.size`
    ).bind(idFile, idTrack, row.backend_id, row.key, ext, bitrate, size),

    // Point the track's denormalized fields at this file iff no existing file ranks higher
    // (flac > mp3 > other). Runs after the track_file insert, so the subquery includes it.
    env.DB.prepare(
      `UPDATE tracks SET suffix = ?, content_type = ?, bit_rate = ?, size = ?, updated_at = datetime('now')
       WHERE id = ?
         AND (SELECT MAX(CASE format WHEN 'flac' THEN 3 WHEN 'mp3' THEN 2 ELSE 1 END)
              FROM track_files WHERE track_id = ?) <= ?`
    ).bind(ext, ext2mime(ext), bitrate, size, idTrack, idTrack, rank),

    // Idempotent album aggregates recomputed from tracks (safe on re-ingest).
    env.DB.prepare(
      `UPDATE albums SET
         song_count = (SELECT COUNT(*) FROM tracks WHERE album_id = ?1),
         duration   = (SELECT COALESCE(SUM(duration), 0) FROM tracks WHERE album_id = ?1),
         updated_at = datetime('now')
       WHERE id = ?1`
    ).bind(idAlbum),

    env.DB.prepare(
      "UPDATE import_worklist SET status = 'done', error = NULL, updated_at = datetime('now') WHERE backend_id = ? AND key = ?"
    ).bind(row.backend_id, row.key),
  ];
  return stmts;
}

async function markError(env: Env, row: PendingRow, msg: string): Promise<void> {
  await env.DB.prepare(
    "UPDATE import_worklist SET status = 'error', error = ?, updated_at = datetime('now') WHERE backend_id = ? AND key = ?"
  ).bind(msg.slice(0, 500), row.backend_id, row.key).run();
}

/**
 * Ingest up to `limit` pending files. One S3 range GET per file.
 * @returns { processed, requests } — requests == number of S3 GETs issued (subrequest budget).
 */
export async function runIngest(env: Env, limit: number): Promise<{ processed: number; requests: number }> {
  const pending = await env.DB.prepare(
    "SELECT backend_id, key, size FROM import_worklist WHERE status = 'pending' ORDER BY updated_at ASC LIMIT ?"
  ).bind(limit).all<PendingRow>();
  const rows = pending.results ?? [];
  if (rows.length === 0) return { processed: 0, requests: 0 };

  // cache resolved S3 configs per backend across the batch
  const cfgCache = new Map<string, S3Config>();
  const resolve = async (id: string): Promise<S3Config> => {
    const cached = cfgCache.get(id);
    if (cached) return cached;
    const backend = (await getBackend(env, id)) as StorageBackendRow | null;
    if (!backend) throw new Error(`backend ${id} not found`);
    const cfg = resolveS3Config(env, backend);
    cfgCache.set(id, cfg);
    return cfg;
  };

  let processed = 0;
  let requests = 0;
  for (const row of rows) {
    try {
      const cfg = await resolve(row.backend_id);
      const ext = extOf(row.key);
      const buf = await getRange(cfg, row.key, 0, HEADER_BYTES - 1);
      requests++;
      if (!buf) {
        await markError(env, row, "range GET failed");
        continue;
      }
      const tags = parseTags(new Uint8Array(buf), ext, row.size ?? buf.byteLength);
      const writes = await buildWrites(env, row, ext, tags);
      await env.DB.batch(writes);
      processed++;
    } catch (err) {
      await markError(env, row, err instanceof Error ? err.message : String(err));
    }
  }
  // Ingest is the only stage that changes the browsable library, so bump the real
  // last-modified timestamp (epoch ms) when any file was actually processed. getIndexes
  // reads this so clients can cache-hit the index until the library truly changes.
  if (processed > 0) {
    await setMeta(env, "library:lastModified", String(Date.now()));
  }
  return { processed, requests };
}
