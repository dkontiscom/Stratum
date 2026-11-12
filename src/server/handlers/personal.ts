// SPDX-License-Identifier: MIT
// Personal read-lists + lyrics (Subsonic "media annotation" reads and lyrics group):
//   getStarred2, getStarred, getNowPlaying, getTopSongs, getSimilarSongs,
//   getSimilarSongs2, getLyrics, getLyricsBySongId.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * starred lists read `annotations` (WHERE starred_at IS NOT NULL) joined back to
//     artists/albums/tracks, not a separate `starred` table;
//   * "now playing" derives from `play_history` (there is no play_queue/now_playing table);
//   * per-user stars/ratings are LEFT JOINed from `annotations` for the authenticated user;
//   * every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline).
import type { Env } from "../../shared";
import { respondError, esc } from "../respond";
import {
  albumJson,
  albumXml,
  annOf,
  artistJson,
  artistXml,
  intParam,
  respondDual,
  songJson,
  songXml,
  type AnnotatedAlbum,
  type AnnotatedTrack,
  type ArtistListItem,
} from "../serialize";

// ── Flat record -> XML attributes (for nowPlaying <entry …/>) ─────────────────

/** Serialize a flat scalar record as XML attributes (skips null/undefined). */
function attrsXml(o: Record<string, unknown>): string {
  return Object.entries(o)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}="${esc(String(v))}"`)
    .join(" ");
}

// ── getStarred2 / getStarred ─────────────────────────────────────────────────
// Both serve the same data (starred artists/albums/songs for the user); they differ
// only in the wrapper element. Subsonic's getStarred and getStarred2 share the
// artist/album/song child shape, so we reuse the slice-2 serializers for both.

interface StarredArtistRow {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
  starred_at: string | null;
}

interface StarredData {
  artists: ArtistListItem[];
  albums: AnnotatedAlbum[];
  songs: AnnotatedTrack[];
}

async function loadStarred(env: Env, user: string): Promise<StarredData> {
  const [artists, albums, songs] = await Promise.all([
    env.DB.prepare(
      `SELECT ar.id, ar.name, ar.image_url,
              (SELECT COUNT(*) FROM albums WHERE artist_id = ar.id) AS album_count,
              ann.starred_at AS starred_at
         FROM annotations ann
         JOIN artists ar ON ar.id = ann.item_id
        WHERE ann.user = ? AND ann.item_type = 'artist' AND ann.starred_at IS NOT NULL
        ORDER BY ann.starred_at DESC`
    )
      .bind(user)
      .all<StarredArtistRow>(),
    env.DB.prepare(
      `SELECT al.*, ann.starred_at AS _starred, ann.rating AS _rating
         FROM annotations ann
         JOIN albums al ON al.id = ann.item_id
        WHERE ann.user = ? AND ann.item_type = 'album' AND ann.starred_at IS NOT NULL
        ORDER BY ann.starred_at DESC`
    )
      .bind(user)
      .all<AnnotatedAlbum>(),
    env.DB.prepare(
      `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
         FROM annotations ann
         JOIN tracks t ON t.id = ann.item_id
        WHERE ann.user = ? AND ann.item_type = 'track' AND ann.starred_at IS NOT NULL
        ORDER BY ann.starred_at DESC`
    )
      .bind(user)
      .all<AnnotatedTrack>(),
  ]);

  return {
    artists: artists.results.map((a) => ({
      id: a.id,
      name: a.name,
      album_count: a.album_count,
      image_url: a.image_url,
      starred_at: a.starred_at,
    })),
    albums: albums.results,
    songs: songs.results,
  };
}

function starredXml(wrapper: string, data: StarredData): string {
  return (
    `<${wrapper}>` +
    data.artists.map((a) => artistXml(a)).join("") +
    data.albums.map((a) => albumXml(a, annOf(a))).join("") +
    data.songs.map((t) => songXml(t, annOf(t))).join("") +
    `</${wrapper}>`
  );
}

function starredJson(data: StarredData): object {
  return {
    artist: data.artists.map(artistJson),
    album: data.albums.map((a) => albumJson(a, annOf(a))),
    song: data.songs.map((t) => songJson(t, annOf(t))),
  };
}

export async function handleGetStarred2(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const data = await loadStarred(env, user);
  return respondDual(params, env, starredXml("starred2", data), {
    starred2: starredJson(data),
  });
}

export async function handleGetStarred(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const data = await loadStarred(env, user);
  return respondDual(params, env, starredXml("starred", data), {
    starred: starredJson(data),
  });
}

// ── getNowPlaying ────────────────────────────────────────────────────────────
// "now playing" is the live `now_playing` table (upserted by scrobble), one row per user,
// shown only within a short freshness window and joined to tracks. Each entry carries the
// song fields plus username (the player), minutesAgo, playerId and playerName. Stars are
// joined for the authenticated user (params `u`). This no longer reads play_history, so
// completed-play history can't leak stale entries into now-playing.

/** Only entries refreshed this recently count as "now playing". */
const NOW_PLAYING_WINDOW = "-10 minutes";
const NOW_PLAYING_LIMIT = 50;

type NowPlayingRow = AnnotatedTrack & {
  _np_user: string;
  _player: string | null;
  _minutes_ago: number;
};

export async function handleGetNowPlaying(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const user = params.get("u") ?? "";

  const rows = await env.DB.prepare(
    `SELECT t.*,
            np.user AS _np_user,
            np.player AS _player,
            CAST((julianday('now') - julianday(np.updated_at)) * 1440 AS INTEGER) AS _minutes_ago,
            ann.starred_at AS _starred, ann.rating AS _rating
       FROM now_playing np
       JOIN tracks t ON t.id = np.track_id
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE np.updated_at >= datetime('now', ?)
      ORDER BY np.updated_at DESC
      LIMIT ${NOW_PLAYING_LIMIT}`
  )
    .bind(user, NOW_PLAYING_WINDOW)
    .all<NowPlayingRow>();

  const entries = rows.results.map((r) => ({
    ...songJson(r, annOf(r)),
    username: r._np_user,
    minutesAgo: r._minutes_ago < 0 ? 0 : r._minutes_ago,
    playerId: 1,
    ...(r._player ? { playerName: r._player } : {}),
  }));

  const xml = `<nowPlaying>${entries.map((e) => `<entry ${attrsXml(e)}/>`).join("")}</nowPlaying>`;
  return respondDual(params, env, xml, { nowPlaying: { entry: entries } });
}

// ── getTopSongs ──────────────────────────────────────────────────────────────
// params: artist (name) + optional count (default 50). The named artist's tracks by
// play_count DESC. The artist name is a bound ? (no interpolation); stars joined for u.

export async function handleGetTopSongs(params: URLSearchParams, env: Env): Promise<Response> {
  const artist = params.get("artist") ?? "";
  const count = intParam(params.get("count"), 50, 500);
  const user = params.get("u") ?? "";

  const rows = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE t.artist_name = ? COLLATE NOCASE
      ORDER BY t.play_count DESC, t.last_played_at DESC
      LIMIT ?`
  )
    .bind(user, artist, count)
    .all<AnnotatedTrack>();

  const xml = `<topSongs>${rows.results.map((t) => songXml(t, annOf(t))).join("")}</topSongs>`;
  return respondDual(params, env, xml, {
    topSongs: { song: rows.results.map((t) => songJson(t, annOf(t))) },
  });
}

// ── getSimilarSongs / getSimilarSongs2 ───────────────────────────────────────
// params: id + optional count (default 50). Ported from the old getSimilarSongsRows:
// random tracks sharing the seed track's genre OR artist. All values bound; stars
// joined for the authenticated user.

async function loadSimilarSongs(
  env: Env,
  user: string,
  id: string,
  count: number
): Promise<AnnotatedTrack[] | null> {
  const seed = await env.DB.prepare(
    "SELECT genre, artist_id FROM tracks WHERE id = ?"
  )
    .bind(id)
    .first<{ genre: string | null; artist_id: string }>();
  if (!seed) return null;

  const rows = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE t.id != ? AND (t.genre = ? OR t.artist_id = ?)
      ORDER BY RANDOM()
      LIMIT ?`
  )
    .bind(user, id, seed.genre, seed.artist_id, count)
    .all<AnnotatedTrack>();
  return rows.results;
}

async function similarSongsResponse(
  params: URLSearchParams,
  env: Env,
  wrapper: "similarSongs" | "similarSongs2"
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const count = intParam(params.get("count"), 50, 500);
  const user = params.get("u") ?? "";

  const songs = await loadSimilarSongs(env, user, id, count);
  if (songs === null) return respondError(params, env, 70, "Song not found");

  const xml = `<${wrapper}>${songs.map((t) => songXml(t, annOf(t))).join("")}</${wrapper}>`;
  return respondDual(params, env, xml, {
    [wrapper]: { song: songs.map((t) => songJson(t, annOf(t))) },
  });
}

export async function handleGetSimilarSongs(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return similarSongsResponse(params, env, "similarSongs");
}

export async function handleGetSimilarSongs2(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return similarSongsResponse(params, env, "similarSongs2");
}

// ── getLyrics ──────────────────────────────────────────────────────────────────
// params: artist + title. Returns <lyrics artist title>text</lyrics> from tracks.lyrics
// matched by title (and artist when given). No match => empty <lyrics> (not an error).
// artist/title in the response echo the request params (Subsonic behaviour).

export async function handleGetLyrics(params: URLSearchParams, env: Env): Promise<Response> {
  const artist = params.get("artist") ?? "";
  const title = params.get("title") ?? "";

  const row = await env.DB.prepare(
    `SELECT lyrics FROM tracks
      WHERE title LIKE ? AND artist_name LIKE ? AND lyrics IS NOT NULL AND lyrics != ''
      LIMIT 1`
  )
    .bind(`%${title}%`, `%${artist}%`)
    .first<{ lyrics: string | null }>();
  const lyrics = row?.lyrics ?? "";

  const xml = `<lyrics artist="${esc(artist)}" title="${esc(title)}">${esc(lyrics)}</lyrics>`;
  return respondDual(params, env, xml, {
    lyrics: { artist, title, value: lyrics },
  });
}

// ── getLyricsBySongId (OpenSubsonic) ─────────────────────────────────────────
// params: id. Returns structured (unsynced) lyrics for the track. No lyrics => empty
// lyricsList (not an error); unknown id => error 70.

interface LyricsTrackRow {
  artist_name: string;
  title: string;
  lyrics: string | null;
}

export async function handleGetLyricsBySongId(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  const track = await env.DB.prepare(
    "SELECT artist_name, title, lyrics FROM tracks WHERE id = ?"
  )
    .bind(id)
    .first<LyricsTrackRow>();
  if (!track) return respondError(params, env, 70, "Song not found");

  const lyrics = track.lyrics ?? "";
  if (!lyrics) {
    return respondDual(params, env, `<lyricsList></lyricsList>`, { lyricsList: {} });
  }

  const lines = lyrics.split("\n");
  const linesXml = lines.map((l) => `<line value="${esc(l)}"/>`).join("");
  const xml =
    `<lyricsList>` +
    `<structuredLyrics displayArtist="${esc(track.artist_name)}" displayTitle="${esc(track.title)}"` +
    ` lang="xxx" offset="0" synced="false">${linesXml}</structuredLyrics>` +
    `</lyricsList>`;

  return respondDual(params, env, xml, {
    lyricsList: {
      structuredLyrics: [
        {
          displayArtist: track.artist_name,
          displayTitle: track.title,
          lang: "xxx",
          offset: 0,
          synced: false,
          line: lines.map((l) => ({ value: l })),
        },
      ],
    },
  });
}
