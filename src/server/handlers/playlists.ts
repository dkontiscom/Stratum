// SPDX-License-Identifier: MIT
// Playlist handlers (Subsonic "playlists" group):
//   getPlaylists, getPlaylist, createPlaylist, updatePlaylist, deletePlaylist.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * the visibility/boolean column is `public` (NOT `is_public` — old bug #5);
//   * identity (owner) comes from the AUTHENTICATED user bound to param `u` by the router;
//   * only the owner may mutate a playlist (error 50 otherwise); admin-override of another
//     user's playlist is OUT OF SCOPE for v1 (owner-only);
//   * playlist_tracks are NEVER inserted one-await-per-row in a loop — all rows are built and
//     run through CHUNKED env.DB.batch calls (#4 discipline);
//   * every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline);
//   * song_count + duration are recomputed from the FINAL (validated) track set.
import type { Env } from "../../shared";
import { respond, respondError, esc } from "../respond";
import {
  annOf,
  respondDual,
  songJson,
  songXml,
  type AnnotatedTrack,
} from "../serialize";

// ── Row shape ────────────────────────────────────────────────────────────────

interface PlaylistRow {
  id: string;
  name: string;
  comment: string | null;
  owner: string;
  public: number; // the schema column is `public` (a boolean 0/1), never `is_public`
  song_count: number;
  duration: number;
  created_at: string | null;
  updated_at: string | null;
}

// ── Chunked multi-row insert of playlist_tracks (#4) ─────────────────────────
// playlist_tracks has 3 bound columns per row. SQLite's bound-variable ceiling is 999,
// so a chunk of 200 rows = 600 binds stays well under it. We emit ONE multi-row INSERT
// per chunk and hand ALL chunk statements to a single env.DB.batch — there is never an
// awaited INSERT per song in a loop.
const CHUNK_ROWS = 200;

/** Build the chunked INSERT statements for a playlist's ordered track ids (positions 0..n-1). */
function playlistTrackInserts(
  env: Env,
  playlistId: string,
  trackIds: string[]
): D1PreparedStatement[] {
  const writes: D1PreparedStatement[] = [];
  for (let i = 0; i < trackIds.length; i += CHUNK_ROWS) {
    const chunk = trackIds.slice(i, i + CHUNK_ROWS);
    const values = chunk.map(() => "(?, ?, ?)").join(", "); // placeholders only — never values
    const binds: unknown[] = [];
    chunk.forEach((tid, j) => binds.push(playlistId, tid, i + j));
    writes.push(
      env.DB.prepare(
        `INSERT INTO playlist_tracks (playlist_id, track_id, position) VALUES ${values}`
      ).bind(...binds)
    );
  }
  return writes;
}

/**
 * Filter `ids` to those that exist in `tracks` (preserving order AND duplicates), and
 * sum their durations. This keeps playlist positions contiguous over REAL tracks, avoids
 * FK violations on a bogus songId, and gives an accurate song_count/duration for the row.
 * Chunked bound IN(...) queries (SQLite's 999-variable ceiling) — placeholders are `?`, values are bound.
 */
async function validTracks(
  env: Env,
  ids: string[]
): Promise<{ ids: string[]; duration: number }> {
  if (!ids.length) return { ids: [], duration: 0 };
  const unique = [...new Set(ids)];
  // The validation SELECT is chunked to respect SQLite's 999 bound-variable ceiling
  // (mirrors the insert chunking above). A chunk of 500 distinct ids stays well under it.
  const CHUNK = 500;
  const dur = new Map<string, number>();
  for (let i = 0; i < unique.length; i += CHUNK) {
    const slice = unique.slice(i, i + CHUNK);
    const placeholders = slice.map(() => "?").join(", ");
    const rows = await env.DB.prepare(
      `SELECT id, duration FROM tracks WHERE id IN (${placeholders})`
    )
      .bind(...slice)
      .all<{ id: string; duration: number }>();
    for (const r of rows.results) dur.set(r.id, r.duration);
  }
  const filtered = ids.filter((id) => dur.has(id));
  const duration = filtered.reduce((sum, id) => sum + (dur.get(id) ?? 0), 0);
  return { ids: filtered, duration };
}

// ── Local playlist serializers ───────────────────────────────────────────────
// Summary (getPlaylists) and header (getPlaylist / create) share these. Entries are
// serialized separately via the shared song serializers.

/** Attribute string for a `<playlist …>` element (no entries). */
function playlistAttrs(p: PlaylistRow): string {
  const parts = [`id="${esc(p.id)}"`, `name="${esc(p.name)}"`];
  if (p.comment) parts.push(`comment="${esc(p.comment)}"`);
  parts.push(`owner="${esc(p.owner)}"`);
  parts.push(`public="${p.public ? "true" : "false"}"`);
  parts.push(`songCount="${p.song_count}"`);
  parts.push(`duration="${p.duration}"`);
  if (p.created_at) parts.push(`created="${esc(p.created_at)}"`);
  if (p.updated_at) parts.push(`changed="${esc(p.updated_at)}"`);
  return parts.join(" ");
}

function playlistJson(p: PlaylistRow): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    owner: p.owner,
    public: !!p.public,
    songCount: p.song_count,
    duration: p.duration,
  };
  if (p.comment) o.comment = p.comment;
  if (p.created_at) o.created = p.created_at;
  if (p.updated_at) o.changed = p.updated_at;
  return o;
}

/**
 * Render a playlist with its ordered song entries (getPlaylist shape). Returns null when
 * the playlist does not exist, so callers can map that to error 70. Stars for the current
 * user are LEFT JOINed per track entry.
 */
async function renderPlaylist(
  params: URLSearchParams,
  env: Env,
  id: string,
  user: string
): Promise<Response | null> {
  const pl = await env.DB.prepare("SELECT * FROM playlists WHERE id = ?")
    .bind(id)
    .first<PlaylistRow>();
  if (!pl) return null;

  // Private playlists are visible only to their owner. Deny others by treating the
  // playlist as not-found (return null → error 70) so we neither serve it nor leak its existence.
  if (!pl.public && pl.owner !== user) return null;

  const tracks = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM playlist_tracks pt
       JOIN tracks t ON t.id = pt.track_id
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position`
  )
    .bind(user, id)
    .all<AnnotatedTrack>();

  const entriesXml = tracks.results.map((t) => songXml(t, annOf(t), "entry")).join("");
  return respondDual(params, env, `<playlist ${playlistAttrs(pl)}>${entriesXml}</playlist>`, {
    playlist: { ...playlistJson(pl), entry: tracks.results.map((t) => songJson(t, annOf(t))) },
  });
}

// ── getPlaylists ─────────────────────────────────────────────────────────────
// Visible to the user: owned by them OR public. Summary rows only (no entries).

export async function handleGetPlaylists(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";
  const rows = await env.DB.prepare(
    "SELECT * FROM playlists WHERE owner = ? OR public = 1 ORDER BY name COLLATE NOCASE"
  )
    .bind(user)
    .all<PlaylistRow>();

  const xml = `<playlists>${rows.results.map((p) => `<playlist ${playlistAttrs(p)}/>`).join("")}</playlists>`;
  return respondDual(params, env, xml, {
    playlists: { playlist: rows.results.map(playlistJson) },
  });
}

// ── getPlaylist ──────────────────────────────────────────────────────────────

export async function handleGetPlaylist(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const res = await renderPlaylist(params, env, id, user);
  if (!res) return respondError(params, env, 70, "Playlist not found");
  return res;
}

// ── createPlaylist ───────────────────────────────────────────────────────────
// params: name + songId (repeatable). Subsonic overloads this call: when `playlistId` is
// supplied instead, it REPLACES that playlist's track list (and may rename it). We treat
// the overload as an owner-only mutation (error 50) for consistency with updatePlaylist —
// a documented hardening of the old handler, which did no owner check there.

export async function handleCreatePlaylist(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";
  const songIds = params.getAll("songId");
  const playlistId = params.get("playlistId");

  // ── Overload: replace an existing playlist's tracks ──
  if (playlistId) {
    const pl = await env.DB.prepare("SELECT owner FROM playlists WHERE id = ?")
      .bind(playlistId)
      .first<{ owner: string }>();
    if (!pl) return respondError(params, env, 70, "Playlist not found");
    if (pl.owner !== user) return respondError(params, env, 50, "Not authorized to modify this playlist");

    const { ids, duration } = await validTracks(env, songIds);
    const name = params.get("name");

    const writes: D1PreparedStatement[] = [
      env.DB.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").bind(playlistId),
      ...playlistTrackInserts(env, playlistId, ids),
    ];
    if (name !== null) {
      writes.push(
        env.DB.prepare(
          "UPDATE playlists SET name = ?, song_count = ?, duration = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(name, ids.length, duration, playlistId)
      );
    } else {
      writes.push(
        env.DB.prepare(
          "UPDATE playlists SET song_count = ?, duration = ?, updated_at = datetime('now') WHERE id = ?"
        ).bind(ids.length, duration, playlistId)
      );
    }
    await env.DB.batch(writes);

    const res = await renderPlaylist(params, env, playlistId, user);
    if (!res) return respondError(params, env, 70, "Playlist not found");
    return res;
  }

  // ── Create a brand-new playlist ──
  const name = params.get("name");
  if (!name) return respondError(params, env, 10, "Missing parameter: name");

  const id = crypto.randomUUID();
  const { ids, duration } = await validTracks(env, songIds);

  // Insert the playlist row FIRST, then its tracks (FK order), all in one atomic batch.
  // public defaults to 0 (the `public` column — never `is_public`).
  const writes: D1PreparedStatement[] = [
    env.DB.prepare(
      "INSERT INTO playlists (id, name, owner, public, song_count, duration) VALUES (?, ?, ?, 0, ?, ?)"
    ).bind(id, name, user, ids.length, duration),
    ...playlistTrackInserts(env, id, ids),
  ];
  await env.DB.batch(writes);

  const res = await renderPlaylist(params, env, id, user);
  if (!res) return respondError(params, env, 70, "Playlist not found");
  return res;
}

// ── updatePlaylist ───────────────────────────────────────────────────────────
// params: playlistId, optional name/comment/public, songIdToAdd (repeatable, appended),
// songIndexToRemove (repeatable, 0-based positions in the CURRENT order). Owner-only
// (error 50). Removals are applied to the current order, additions appended, then the
// positions are REBUILT contiguously and song_count/duration recomputed. All track writes
// are chunk-batched (#4) and run atomically with the metadata update.

export async function handleUpdatePlaylist(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("playlistId");
  if (!id) return respondError(params, env, 10, "Missing parameter: playlistId");
  const user = params.get("u") ?? "";

  const pl = await env.DB.prepare("SELECT owner FROM playlists WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (!pl) return respondError(params, env, 70, "Playlist not found");
  if (pl.owner !== user) return respondError(params, env, 50, "Not authorized to modify this playlist");

  // Current order.
  const current = await env.DB.prepare(
    "SELECT track_id FROM playlist_tracks WHERE playlist_id = ? ORDER BY position"
  )
    .bind(id)
    .all<{ track_id: string }>();

  // Apply removals (0-based indices into the current order), then append additions.
  const removeSet = new Set(
    params
      .getAll("songIndexToRemove")
      .map((s) => parseInt(s, 10))
      .filter((n) => Number.isFinite(n))
  );
  const kept = current.results
    .map((r) => r.track_id)
    .filter((_, idx) => !removeSet.has(idx));
  const nextIds = kept.concat(params.getAll("songIdToAdd"));

  // Validate the final set (drops bogus/deleted ids, keeps order + duplicates) for an
  // accurate song_count/duration and FK-safe inserts.
  const { ids, duration } = await validTracks(env, nextIds);

  // Rebuild positions contiguously: wipe + chunked re-insert, plus the metadata/stat update,
  // all in ONE atomic batch.
  const sets = ["song_count = ?", "duration = ?", "updated_at = datetime('now')"];
  const updateBinds: unknown[] = [ids.length, duration];
  const name = params.get("name");
  if (name !== null) {
    sets.unshift("name = ?");
    updateBinds.unshift(name);
  }
  const comment = params.get("comment");
  if (comment !== null) {
    sets.push("comment = ?");
    updateBinds.push(comment);
  }
  const pub = params.get("public");
  if (pub !== null) {
    sets.push("public = ?"); // the `public` column (0/1), never `is_public`
    updateBinds.push(pub === "true" || pub === "1" ? 1 : 0);
  }
  updateBinds.push(id);

  const writes: D1PreparedStatement[] = [
    env.DB.prepare("DELETE FROM playlist_tracks WHERE playlist_id = ?").bind(id),
    ...playlistTrackInserts(env, id, ids),
    env.DB.prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE id = ?`).bind(...updateBinds),
  ];
  await env.DB.batch(writes);

  return respond(params, env, "");
}

// ── deletePlaylist ───────────────────────────────────────────────────────────
// Owner-only (error 50). Deleting the playlist cascades playlist_tracks via the FK.

export async function handleDeletePlaylist(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const pl = await env.DB.prepare("SELECT owner FROM playlists WHERE id = ?")
    .bind(id)
    .first<{ owner: string }>();
  if (!pl) return respondError(params, env, 70, "Playlist not found");
  if (pl.owner !== user) return respondError(params, env, 50, "Not authorized to delete this playlist");

  await env.DB.prepare("DELETE FROM playlists WHERE id = ?").bind(id).run();
  return respond(params, env, "");
}
