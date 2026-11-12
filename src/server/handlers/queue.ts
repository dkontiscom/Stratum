// SPDX-License-Identifier: MIT
// Play-queue + bookmark handlers (Subsonic "bookmarks" group):
//   savePlayQueue, getPlayQueue, createBookmark, getBookmarks, deleteBookmark.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * the saved queue is split across TWO tables — play_queue_state (the single current
//     track/position row) and play_queue_items (the ordered ids) — not one wide `play_queue`;
//   * identity (the user) comes from the AUTHENTICATED user bound to param `u` by the router;
//   * queue items are NEVER inserted one-await-per-row in a loop — all rows are built and run
//     through CHUNKED env.DB.batch calls (#4 discipline);
//   * every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline).
import type { Env } from "../../shared";
import { respond, respondError, esc } from "../respond";
import {
  annOf,
  intParam,
  respondDual,
  songJson,
  songXml,
  type AnnotatedTrack,
} from "../serialize";

// ── Chunked multi-row insert of play_queue_items (#4) ────────────────────────
// play_queue_items has 3 bound columns per row; SQLite's bound-variable ceiling is 999, so
// a chunk of 200 rows = 600 binds stays well under it. We emit ONE multi-row INSERT per
// chunk and hand ALL chunk statements to a single env.DB.batch — never an awaited per-row loop.
const CHUNK_ROWS = 200;

/** Build the chunked INSERT statements for a user's ordered queue (positions 0..n-1). */
function queueItemInserts(env: Env, user: string, trackIds: string[]): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < trackIds.length; i += CHUNK_ROWS) {
    const chunk = trackIds.slice(i, i + CHUNK_ROWS);
    const values = chunk.map(() => "(?, ?, ?)").join(", "); // placeholders only — never values
    const binds: unknown[] = [];
    chunk.forEach((tid, j) => binds.push(user, tid, i + j));
    writes.push(
      env.DB.prepare(
        `INSERT INTO play_queue_items (user, track_id, position) VALUES ${values}`
      ).bind(...binds)
    );
  }
  return writes;
}

/** Filter `ids` to those that exist in `tracks`, preserving order AND duplicates (FK-safe). */
async function existingTrackIds(env: Env, ids: string[]): Promise<string[]> {
  if (!ids.length) return [];
  const unique = [...new Set(ids)];
  // The validation SELECT is chunked to respect SQLite's 999 bound-variable ceiling
  // (mirrors the insert chunking above). A chunk of 500 distinct ids stays well under it.
  const CHUNK = 500;
  const valid = new Set<string>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(", ");
    const rows = await env.DB.prepare(`SELECT id FROM tracks WHERE id IN (${placeholders})`)
      .bind(...slice)
      .all<{ id: string }>();
    for (const r of rows.results) valid.add(r.id);
  }
  return ids.filter((id) => valid.has(id));
}

// ── savePlayQueue ────────────────────────────────────────────────────────────
// params: id (repeatable — the queue in order), optional current (current track id),
// optional position (ms). Replace the user's queue atomically: wipe play_queue_items, insert
// the new ordered items (chunk-batched), and upsert play_queue_state. No ids => clear both.

export async function handleSavePlayQueue(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";
  const ids = params.getAll("id");

  // Clear request: wipe the queue items AND the state so getPlayQueue returns an empty envelope.
  if (!ids.length) {
    await env.DB.batch([
      env.DB.prepare("DELETE FROM play_queue_items WHERE user = ?").bind(user),
      env.DB.prepare("DELETE FROM play_queue_state WHERE user = ?").bind(user),
    ]);
    return respond(params, env, "");
  }

  const valid = await existingTrackIds(env, ids);

  // Guard against silent data loss: the caller submitted ids but none resolve to real tracks
  // (e.g. stale ids after a re-import). Clearing the queue is expressed by sending NO ids, so
  // here we preserve the existing saved queue rather than erasing it. Return success, no write.
  if (!valid.length) return respond(params, env, "");

  const current = params.get("current"); // nullable; no FK on play_queue_state.current_track_id
  const position = intParam(params.get("position"), 0);

  const writes: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM play_queue_items WHERE user = ?").bind(user),
    ...queueItemInserts(env, user, valid),
    env.DB.prepare(
      `INSERT INTO play_queue_state (user, current_track_id, current_position, changed_at)
         VALUES (?, ?, ?, datetime('now'))
       ON CONFLICT(user) DO UPDATE SET
         current_track_id = excluded.current_track_id,
         current_position = excluded.current_position,
         changed_at = datetime('now')`
    ).bind(user, current ?? null, position),
  ];
  await env.DB.batch(writes);

  return respond(params, env, "");
}

// ── getPlayQueue ─────────────────────────────────────────────────────────────
// Return the saved queue with its ordered song entries. No saved state => empty envelope.

interface QueueStateRow {
  current_track_id: string | null;
  current_position: number;
  changed_at: string | null;
}

export async function handleGetPlayQueue(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";

  const state = await env.DB.prepare(
    "SELECT current_track_id, current_position, changed_at FROM play_queue_state WHERE user = ?"
  )
    .bind(user)
    .first<QueueStateRow>();
  if (!state) return respond(params, env, ""); // no saved queue → empty success (no playQueue element)

  const tracks = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM play_queue_items pq
       JOIN tracks t ON t.id = pq.track_id
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE pq.user = ?
      ORDER BY pq.position`
  )
    .bind(user, user)
    .all<AnnotatedTrack>();

  const attrs = [
    ...(state.current_track_id ? [`current="${esc(state.current_track_id)}"`] : []),
    `position="${state.current_position}"`,
    `username="${esc(user)}"`,
    ...(state.changed_at ? [`changed="${esc(state.changed_at)}"`] : []),
  ].join(" ");
  const entriesXml = tracks.results.map((t) => songXml(t, annOf(t), "entry")).join("");

  const data: Record<string, unknown> = {
    position: state.current_position,
    username: user,
    entry: tracks.results.map((t) => songJson(t, annOf(t))),
  };
  if (state.current_track_id) data.current = state.current_track_id;
  if (state.changed_at) data.changed = state.changed_at;

  return respondDual(params, env, `<playQueue ${attrs}>${entriesXml}</playQueue>`, {
    playQueue: data,
  });
}

// ── createBookmark ───────────────────────────────────────────────────────────
// params: id (track), position (ms), optional comment. UPSERT on (user, track_id).

export async function handleCreateBookmark(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";
  const position = intParam(params.get("position"), 0);
  const comment = params.get("comment"); // nullable

  const track = await env.DB.prepare("SELECT 1 AS ok FROM tracks WHERE id = ?")
    .bind(id)
    .first<{ ok: number }>();
  if (!track) return respondError(params, env, 70, "Track not found");

  await env.DB.prepare(
    `INSERT INTO bookmarks (user, track_id, position, comment, changed_at)
       VALUES (?, ?, ?, ?, datetime('now'))
     ON CONFLICT(user, track_id) DO UPDATE SET
       position = excluded.position, comment = excluded.comment, changed_at = datetime('now')`
  )
    .bind(user, id, position, comment ?? null)
    .run();

  return respond(params, env, "");
}

// ── getBookmarks ─────────────────────────────────────────────────────────────
// The user's bookmarks, each wrapping its bookmarked song as an `entry` child. Bookmark
// columns are aliased (b_*) because `tracks` also has a `created_at` that would collide.

interface BookmarkTrackRow extends AnnotatedTrack {
  b_position: number;
  b_comment: string | null;
  b_created: string | null;
  b_changed: string | null;
}

export async function handleGetBookmarks(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";

  const rows = await env.DB.prepare(
    `SELECT b.position AS b_position, b.comment AS b_comment,
            b.created_at AS b_created, b.changed_at AS b_changed,
            t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM bookmarks b
       JOIN tracks t ON t.id = b.track_id
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE b.user = ?
      ORDER BY b.changed_at DESC`
  )
    .bind(user, user)
    .all<BookmarkTrackRow>();

  const xml = rows.results
    .map(
      (b) =>
        `<bookmark position="${b.b_position}" username="${esc(user)}" comment="${esc(b.b_comment ?? "")}" created="${esc(b.b_created ?? "")}" changed="${esc(b.b_changed ?? "")}">${songXml(b, annOf(b), "entry")}</bookmark>`
    )
    .join("");
  return respondDual(params, env, `<bookmarks>${xml}</bookmarks>`, {
    bookmarks: {
      bookmark: rows.results.map((b) => ({
        position: b.b_position,
        username: user,
        comment: b.b_comment ?? "",
        created: b.b_created,
        changed: b.b_changed,
        entry: songJson(b, annOf(b)),
      })),
    },
  });
}

// ── deleteBookmark ───────────────────────────────────────────────────────────
// params: id (track). Remove the user's bookmark for that track.

export async function handleDeleteBookmark(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  await env.DB.prepare("DELETE FROM bookmarks WHERE user = ? AND track_id = ?")
    .bind(user, id)
    .run();
  return respond(params, env, "");
}
