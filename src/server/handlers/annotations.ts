// SPDX-License-Identifier: MIT
// Annotation + play-logging handlers (Subsonic "media annotation" group):
//   star, unstar, setRating, scrobble, playbackReport.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * stars/ratings live in `annotations` (PK user,item_type,item_id) written via UPSERT,
//     not a separate `starred` table or a `user_rating` column (fix: schema drift);
//   * multi-id writes are collected and run through a SINGLE env.DB.batch(), never an
//     awaited INSERT per id in a loop (#4 discipline);
//   * every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline).
import type { Env } from "../../shared";
import { respond, respondError } from "../respond";

// ── Shared: annotation UPSERT statements ─────────────────────────────────────
// One row per (user, item_type, item_id). Star/unstar touches starred_at only;
// setRating touches rating only — so a star never clobbers a rating and vice versa.

type ItemType = "track" | "album" | "artist";

/** UPSERT setting starred_at: `datetime('now')` to star, `NULL` to unstar. */
function starStmt(env: Env, user: string, type: ItemType, id: string, starred: boolean): D1PreparedStatement {
  // starred_at is a bound column value (NULL or the server clock); never interpolated.
  return env.DB.prepare(
    `INSERT INTO annotations (user, item_type, item_id, starred_at)
       VALUES (?, ?, ?, ${starred ? "datetime('now')" : "NULL"})
     ON CONFLICT(user, item_type, item_id)
       DO UPDATE SET starred_at = ${starred ? "datetime('now')" : "NULL"}`
  ).bind(user, type, id);
}

/** Collect every (type,id) carried by the request into a batch of starred-at upserts. */
function collectStarWrites(params: URLSearchParams, env: Env, user: string, starred: boolean): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [];
  for (const id of params.getAll("id")) writes.push(starStmt(env, user, "track", id, starred));
  for (const id of params.getAll("albumId")) writes.push(starStmt(env, user, "album", id, starred));
  for (const id of params.getAll("artistId")) writes.push(starStmt(env, user, "artist", id, starred));
  return writes;
}

// ── star / unstar ────────────────────────────────────────────────────────────
// A request may carry MANY ids (id/albumId/artistId all repeatable). We build all
// upserts first and run them in ONE env.DB.batch — no awaited per-id loop (#4).

export async function handleStar(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const writes = collectStarWrites(params, env, user, true);
  if (writes.length) await env.DB.batch(writes);
  return respond(params, env, "");
}

export async function handleUnstar(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const writes = collectStarWrites(params, env, user, false);
  if (writes.length) await env.DB.batch(writes);
  return respond(params, env, "");
}

// ── setRating ──────────────────────────────────────────────────────────────────
// params: id + rating (0..5). rating 0 CLEARS the rating (-> NULL). The id may be a
// track, album or artist: we probe the three tables in one query and annotate whichever
// it is, defaulting to 'track' when it matches nothing (harmless — clients only rate
// real items). This is the new-schema equivalent of the old "try track, then album".

export async function handleSetRating(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  let rating = parseInt(params.get("rating") ?? "", 10);
  if (!Number.isFinite(rating)) rating = 0;
  if (rating < 0) rating = 0;
  if (rating > 5) rating = 5;
  const value: number | null = rating === 0 ? null : rating;

  // Which table owns this id? One bound query, no interpolation.
  const kind = await env.DB.prepare(
    `SELECT 'track' AS t FROM tracks  WHERE id = ?
     UNION ALL SELECT 'album'         FROM albums  WHERE id = ?
     UNION ALL SELECT 'artist'        FROM artists WHERE id = ?
     LIMIT 1`
  )
    .bind(id, id, id)
    .first<{ t: ItemType }>();
  const itemType: ItemType = kind?.t ?? "track";

  await env.DB.prepare(
    `INSERT INTO annotations (user, item_type, item_id, rating)
       VALUES (?, ?, ?, ?)
     ON CONFLICT(user, item_type, item_id)
       DO UPDATE SET rating = excluded.rating`
  )
    .bind(user, itemType, id, value)
    .run();

  return respond(params, env, "");
}

// ── Play logging (scrobble / playbackReport) ─────────────────────────────────
// Every play write refreshes the user's `now_playing` row (live state). A "real" play
// (submission=true) ALSO logs a row in `play_history` and bumps the global play_count /
// last_played_at on the track and its album. A "now playing" ping (submission=false)
// touches ONLY now_playing — it never writes play_history, so the completed-play log
// stays clean and getNowPlaying reflects live state via a freshness window.

interface TrackAlbumRow {
  id: string;
  album_id: string;
}

/** Look up album_ids for the given track ids in ONE bound IN(...) query. */
async function albumIdsFor(env: Env, ids: string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const placeholders = unique.map(() => "?").join(", "); // bound ? per id — never interpolated values
  const rows = await env.DB.prepare(
    `SELECT id, album_id FROM tracks WHERE id IN (${placeholders})`
  )
    .bind(...unique)
    .all<TrackAlbumRow>();
  return new Map(rows.results.map((r) => [r.id, r.album_id]));
}

/**
 * Build the batch of play writes for `ids`. The two submission types are disjoint:
 * when `countsToo` is true (a COMPLETED play, submission=true) each known track appends a
 * play_history row and bumps tracks + albums play_count/last_played_at — but does NOT touch
 * now_playing, because a finished track is not "currently playing". When `countsToo` is false
 * (a now-playing ping, submission=false) each known track ONLY upserts the user's now_playing
 * row (live state; last id wins) and writes no history/stats. Unknown ids are skipped
 * (FK to tracks). All statements are collected for a single batch — no per-id awaits (#4).
 * `player` is the Subsonic client name (`c`), stored on now_playing.
 */
async function buildPlayWrites(
  env: Env,
  user: string,
  ids: string[],
  countsToo: boolean,
  player: string
): Promise<D1PreparedStatement[]> {
  const albums = await albumIdsFor(env, ids);
  const writes: D1PreparedStatement[] = [];
  for (const id of ids) {
    const albumId = albums.get(id);
    if (albumId === undefined) continue; // not a real track — don't violate the FK

    if (countsToo) {
      // Completed play (submission=true): log history + bump stats; do NOT touch now_playing.
      writes.push(
        env.DB.prepare("INSERT INTO play_history (user, track_id) VALUES (?, ?)").bind(user, id)
      );
      writes.push(
        env.DB.prepare(
          "UPDATE tracks SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?"
        ).bind(id)
      );
      writes.push(
        env.DB.prepare(
          "UPDATE albums SET play_count = play_count + 1, last_played_at = datetime('now') WHERE id = ?"
        ).bind(albumId)
      );
    } else {
      // Now-playing ping (submission=false): refresh live state only (last id wins for the single row).
      writes.push(
        env.DB.prepare(
          `INSERT INTO now_playing (user, track_id, player, updated_at)
             VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT(user) DO UPDATE SET
             track_id = excluded.track_id, player = excluded.player, updated_at = datetime('now')`
        ).bind(user, id, player)
      );
    }
  }
  return writes;
}

// ── scrobble ───────────────────────────────────────────────────────────────────
// params: id (repeatable), optional time (ignored — we stamp server-side), optional
// submission (default true). submission!=false => full scrobble (now_playing + history +
// stats); submission=false => now-playing ping only (now_playing, no history/stats).

export async function handleScrobble(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const player = params.get("c") ?? "";
  const ids = params.getAll("id");
  const submission = params.get("submission") !== "false";
  const writes = await buildPlayWrites(env, user, ids, submission, player);
  if (writes.length) await env.DB.batch(writes);
  return respond(params, env, "");
}

// ── playbackReport ─────────────────────────────────────────────────────────────
// A scrobble-like ack the old server implemented. event=play (the default) records a
// full play; any other event is a no-op ack. Empty success envelope either way.

export async function handlePlaybackReport(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";
  const player = params.get("c") ?? "";
  const id = params.get("id");
  const event = params.get("event") ?? "play";
  if (id && event === "play") {
    const writes = await buildPlayWrites(env, user, [id], true, player);
    if (writes.length) await env.DB.batch(writes);
  }
  return respond(params, env, "");
}
