// SPDX-License-Identifier: MIT
// Browsing + listing handlers (Subsonic "browsing" and "album/song lists" groups):
//   getMusicFolders, getIndexes, getMusicDirectory, getArtists, getArtist,
//   getArtistInfo2, getAlbum, getAlbumInfo2, getAlbumList2, getAlbumList, getSong,
//   getGenres, getSongsByGenre, getRandomSongs.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * per-user stars/ratings come from `annotations` (no `starred` table / `user_rating`
//     column), LEFT JOINed for the authenticated user (params `u`);
//   * artist album counts are computed, never hardcoded to 0 (fix #5);
//   * every user-supplied value is a bound `?` parameter, never interpolated (fix #3).
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

/** OpenSubsonic ignoredArticles: stripped when bucketing/indexing by first letter. */
const IGNORED_ARTICLES = "The An A";

/** Strip a leading ignored article ("The Beatles" -> "Beatles") for index bucketing. */
function stripArticle(name: string): string {
  const n = name.trim();
  for (const art of IGNORED_ARTICLES.split(" ")) {
    const prefix = art.toLowerCase() + " ";
    if (n.toLowerCase().startsWith(prefix)) return n.slice(art.length + 1).trim();
  }
  return n;
}

/** First-letter index bucket (A–Z, else '#') after article stripping. */
function indexLetter(name: string): string {
  const c = stripArticle(name).charAt(0).toUpperCase();
  return /^[A-Z]$/.test(c) ? c : "#";
}

// ── getMusicFolders ──────────────────────────────────────────────────────────
// Single logical folder (the library is flat to the API; backends are internal).

export async function handleGetMusicFolders(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return respondDual(
    params,
    env,
    `<musicFolders><musicFolder id="1" name="Music"/></musicFolders>`,
    { musicFolders: { musicFolder: [{ id: "1", name: "Music" }] } }
  );
}

// ── getIndexes / getArtists (shared index build) ─────────────────────────────

interface ArtistIndexRow {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
  starred_at: string | null;
}

async function loadArtistIndex(
  env: Env,
  user: string
): Promise<Map<string, ArtistListItem[]>> {
  const rows = await env.DB.prepare(
    `SELECT ar.id, ar.name, ar.image_url,
            (SELECT COUNT(*) FROM albums WHERE artist_id = ar.id) AS album_count,
            ann.starred_at AS starred_at
       FROM artists ar
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'artist' AND ann.item_id = ar.id
      ORDER BY ar.name COLLATE NOCASE`
  )
    .bind(user)
    .all<ArtistIndexRow>();

  const byLetter = new Map<string, ArtistListItem[]>();
  for (const a of rows.results) {
    const item: ArtistListItem = {
      id: a.id,
      name: a.name,
      album_count: a.album_count,
      image_url: a.image_url,
      starred_at: a.starred_at,
    };
    const letter = indexLetter(a.name);
    const bucket = byLetter.get(letter);
    if (bucket) bucket.push(item);
    else byLetter.set(letter, [item]);
  }
  return byLetter;
}

function sortedBuckets(byLetter: Map<string, ArtistListItem[]>): [string, ArtistListItem[]][] {
  return [...byLetter.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function indexXml(byLetter: Map<string, ArtistListItem[]>): string {
  return sortedBuckets(byLetter)
    .map(
      ([letter, artists]) =>
        `<index name="${esc(letter)}">${artists.map((a) => artistXml(a)).join("")}</index>`
    )
    .join("");
}

function indexJson(byLetter: Map<string, ArtistListItem[]>): object[] {
  return sortedBuckets(byLetter).map(([name, artists]) => ({
    name,
    artist: artists.map(artistJson),
  }));
}

export async function handleGetIndexes(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const byLetter = await loadArtistIndex(env, user);
  const lastModified = Date.now();
  return respondDual(
    params,
    env,
    `<indexes ignoredArticles="${IGNORED_ARTICLES}" lastModified="${lastModified}">${indexXml(byLetter)}</indexes>`,
    {
      indexes: {
        ignoredArticles: IGNORED_ARTICLES,
        lastModified,
        index: indexJson(byLetter),
      },
    }
  );
}

export async function handleGetArtists(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const byLetter = await loadArtistIndex(env, user);
  return respondDual(
    params,
    env,
    `<artists ignoredArticles="${IGNORED_ARTICLES}">${indexXml(byLetter)}</artists>`,
    { artists: { ignoredArticles: IGNORED_ARTICLES, index: indexJson(byLetter) } }
  );
}

// ── getMusicDirectory ────────────────────────────────────────────────────────
// Folder-style browse: an artist id lists its albums (as directories); an album id
// lists its tracks (as children).

export async function handleGetMusicDirectory(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const artist = await env.DB.prepare("SELECT id, name FROM artists WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string }>();
  if (artist) {
    const albums = await env.DB.prepare(
      "SELECT * FROM albums WHERE artist_id = ? ORDER BY year, name COLLATE NOCASE"
    )
      .bind(id)
      .all<AnnotatedAlbum>();
    const childXml = albums.results
      .map(
        (a) =>
          `<child id="${esc(a.id)}" parent="${esc(id)}" title="${esc(a.name)}" isDir="true" album="${esc(a.name)}" artist="${esc(artist.name)}"${a.year != null ? ` year="${a.year}"` : ""} songCount="${a.song_count}" coverArt="${esc(a.id)}"/>`
      )
      .join("");
    const childJson = albums.results.map((a) => ({
      id: a.id,
      parent: id,
      title: a.name,
      isDir: true,
      album: a.name,
      artist: artist.name,
      ...(a.year != null ? { year: a.year } : {}),
      songCount: a.song_count,
      coverArt: a.id,
    }));
    return respondDual(
      params,
      env,
      `<directory id="${esc(id)}" name="${esc(artist.name)}" parent="1">${childXml}</directory>`,
      { directory: { id, name: artist.name, parent: "1", child: childJson } }
    );
  }

  const album = await env.DB.prepare("SELECT id, name, artist_id FROM albums WHERE id = ?")
    .bind(id)
    .first<{ id: string; name: string; artist_id: string }>();
  if (album) {
    const tracks = await env.DB.prepare(
      `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
         FROM tracks t
         LEFT JOIN annotations ann
           ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
        WHERE t.album_id = ?
        ORDER BY t.disc_number, t.track_number`
    )
      .bind(user, id)
      .all<AnnotatedTrack>();
    const childXml = tracks.results.map((t) => songXml(t, annOf(t), "child")).join("");
    const childJson = tracks.results.map((t) => songJson(t, annOf(t)));
    return respondDual(
      params,
      env,
      `<directory id="${esc(id)}" name="${esc(album.name)}" parent="${esc(album.artist_id)}">${childXml}</directory>`,
      { directory: { id, name: album.name, parent: album.artist_id, child: childJson } }
    );
  }

  return respondError(params, env, 70, "Directory not found");
}

// ── getArtist ────────────────────────────────────────────────────────────────

export async function handleGetArtist(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const artist = await env.DB.prepare(
    `SELECT ar.id, ar.name, ar.image_url, ann.starred_at AS _starred
       FROM artists ar
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'artist' AND ann.item_id = ar.id
      WHERE ar.id = ?`
  )
    .bind(user, id)
    .first<{ id: string; name: string; image_url: string | null; _starred: string | null }>();
  if (!artist) return respondError(params, env, 70, "Artist not found");

  const albums = await env.DB.prepare(
    `SELECT al.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM albums al
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'album' AND ann.item_id = al.id
      WHERE al.artist_id = ?
      ORDER BY al.year, al.name COLLATE NOCASE`
  )
    .bind(user, id)
    .all<AnnotatedAlbum>();

  const albumCount = albums.results.length;
  const starred = artist._starred ? ` starred="${esc(artist._starred)}"` : "";
  const albumsXml = albums.results.map((a) => albumXml(a, annOf(a))).join("");
  const artistJsonObj: Record<string, unknown> = {
    id: artist.id,
    name: artist.name,
    albumCount,
    coverArt: artist.id,
    album: albums.results.map((a) => albumJson(a, annOf(a))),
  };
  if (artist._starred) artistJsonObj.starred = artist._starred;

  return respondDual(
    params,
    env,
    `<artist id="${esc(artist.id)}" name="${esc(artist.name)}" albumCount="${albumCount}" coverArt="${esc(artist.id)}"${starred}>${albumsXml}</artist>`,
    { artist: artistJsonObj }
  );
}

// ── getArtistInfo2 ───────────────────────────────────────────────────────────

interface ArtistInfoRow {
  biography: string | null;
  image_url: string | null;
  mbz_artist_id: string | null;
  lastfm_url: string | null;
  similar_json: string | null;
}

interface SimilarArtist {
  id?: string;
  name?: string;
}

export async function handleGetArtistInfo2(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  const artist = await env.DB.prepare(
    "SELECT biography, image_url, mbz_artist_id, lastfm_url, similar_json FROM artists WHERE id = ?"
  )
    .bind(id)
    .first<ArtistInfoRow>();
  if (!artist) return respondError(params, env, 70, "Artist not found");

  const bio = artist.biography ?? "";
  const imageUrl = artist.image_url ?? "";
  const mbzId = artist.mbz_artist_id ?? "";
  const lastfmUrl = artist.lastfm_url ?? "";

  let similar: SimilarArtist[] = [];
  if (artist.similar_json) {
    try {
      const parsed = JSON.parse(artist.similar_json) as unknown;
      if (Array.isArray(parsed)) {
        similar = parsed
          .map((s): SimilarArtist =>
            typeof s === "string" ? { name: s } : (s as SimilarArtist)
          )
          .slice(0, 20);
      }
    } catch {
      // Malformed enrichment JSON: just omit similar artists.
    }
  }

  const similarXml = similar
    .map((s) => `<similarArtist id="${esc(s.id ?? "")}" name="${esc(s.name ?? "")}"/>`)
    .join("");
  const xml =
    `<artistInfo2>` +
    (bio ? `<biography>${esc(bio)}</biography>` : "") +
    `<musicBrainzId>${esc(mbzId)}</musicBrainzId>` +
    `<lastFmUrl>${esc(lastfmUrl)}</lastFmUrl>` +
    `<smallImageUrl>${esc(imageUrl)}</smallImageUrl>` +
    `<mediumImageUrl>${esc(imageUrl)}</mediumImageUrl>` +
    `<largeImageUrl>${esc(imageUrl)}</largeImageUrl>` +
    similarXml +
    `</artistInfo2>`;

  return respondDual(params, env, xml, {
    artistInfo2: {
      biography: bio,
      musicBrainzId: mbzId,
      lastFmUrl: lastfmUrl,
      smallImageUrl: imageUrl,
      mediumImageUrl: imageUrl,
      largeImageUrl: imageUrl,
      similarArtist: similar.map((s) => ({ id: s.id ?? "", name: s.name ?? "" })),
    },
  });
}

// ── getAlbum ─────────────────────────────────────────────────────────────────

export async function handleGetAlbum(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const album = await env.DB.prepare(
    `SELECT al.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM albums al
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'album' AND ann.item_id = al.id
      WHERE al.id = ?`
  )
    .bind(user, id)
    .first<AnnotatedAlbum>();
  if (!album) return respondError(params, env, 70, "Album not found");

  const tracks = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE t.album_id = ?
      ORDER BY t.disc_number, t.track_number`
  )
    .bind(user, id)
    .all<AnnotatedTrack>();

  const songsXml = tracks.results.map((t) => songXml(t, annOf(t))).join("");
  return respondDual(params, env, albumXml(album, annOf(album), songsXml), {
    album: { ...albumJson(album, annOf(album)), song: tracks.results.map((t) => songJson(t, annOf(t))) },
  });
}

// ── getAlbumInfo2 ────────────────────────────────────────────────────────────

export async function handleGetAlbumInfo2(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  const album = await env.DB.prepare(
    "SELECT notes, mbz_release_id FROM albums WHERE id = ?"
  )
    .bind(id)
    .first<{ notes: string | null; mbz_release_id: string | null }>();
  if (!album) return respondError(params, env, 70, "Album not found");

  const notes = album.notes ?? "";
  const mbzId = album.mbz_release_id ?? "";
  const xml =
    `<albumInfo>` +
    (notes ? `<notes>${esc(notes)}</notes>` : "") +
    `<musicBrainzId>${esc(mbzId)}</musicBrainzId>` +
    `</albumInfo>`;
  return respondDual(params, env, xml, {
    albumInfo: { notes, musicBrainzId: mbzId },
  });
}

// ── getAlbumList2 / getAlbumList ─────────────────────────────────────────────
// Fix #3: byYear/byGenre (and every other type) use bound ? params exclusively.

/** Build the album-list SQL + binds for a `type`. First bind is always the user. */
function albumListQuery(
  type: string,
  params: URLSearchParams,
  user: string,
  size: number,
  offset: number
): { sql: string; binds: unknown[] } {
  const base =
    `SELECT al.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM albums al
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'album' AND ann.item_id = al.id`;
  const binds: unknown[] = [user];
  let where = "";
  let order: string;

  switch (type) {
    case "recent":
      order = "al.last_played_at IS NULL, al.last_played_at DESC";
      break;
    case "frequent":
      order = "al.play_count DESC";
      break;
    case "random":
      order = "RANDOM()";
      break;
    case "alphabeticalByName":
      order = "al.name COLLATE NOCASE";
      break;
    case "alphabeticalByArtist":
      order = "al.artist_name COLLATE NOCASE, al.name COLLATE NOCASE";
      break;
    case "starred":
      where = "WHERE ann.starred_at IS NOT NULL";
      order = "ann.starred_at DESC";
      break;
    case "highest":
      where = "WHERE ann.rating IS NOT NULL";
      order = "ann.rating DESC";
      break;
    case "byGenre": {
      where = "WHERE al.genre = ?";
      binds.push(params.get("genre") ?? "");
      order = "al.name COLLATE NOCASE";
      break;
    }
    case "byYear": {
      const from = intParam(params.get("fromYear"), 0);
      const to = intParam(params.get("toYear"), 0);
      where = "WHERE al.year BETWEEN ? AND ?";
      binds.push(Math.min(from, to), Math.max(from, to));
      // Subsonic: fromYear>toYear means descending (reverse chronological).
      order = from <= to ? "al.year" : "al.year DESC";
      break;
    }
    case "newest":
    default:
      order = "al.created_at DESC";
      break;
  }

  binds.push(size, offset);
  return { sql: `${base} ${where} ORDER BY ${order} LIMIT ? OFFSET ?`, binds };
}

async function albumListResponse(
  params: URLSearchParams,
  env: Env,
  wrapper: "albumList2" | "albumList"
): Promise<Response> {
  const type = params.get("type") ?? "newest";
  const size = intParam(params.get("size"), 10, 500);
  const offset = intParam(params.get("offset"), 0);
  const user = params.get("u") ?? "";

  const { sql, binds } = albumListQuery(type, params, user, size, offset);
  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<AnnotatedAlbum>();

  const xml = `<${wrapper}>${rows.results.map((a) => albumXml(a, annOf(a))).join("")}</${wrapper}>`;
  return respondDual(params, env, xml, {
    [wrapper]: { album: rows.results.map((a) => albumJson(a, annOf(a))) },
  });
}

export async function handleGetAlbumList2(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return albumListResponse(params, env, "albumList2");
}

export async function handleGetAlbumList(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return albumListResponse(params, env, "albumList");
}

// ── getSong ──────────────────────────────────────────────────────────────────

export async function handleGetSong(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");
  const user = params.get("u") ?? "";

  const track = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE t.id = ?`
  )
    .bind(user, id)
    .first<AnnotatedTrack>();
  if (!track) return respondError(params, env, 70, "Song not found");

  return respondDual(params, env, songXml(track, annOf(track)), {
    song: songJson(track, annOf(track)),
  });
}

// ── getGenres ────────────────────────────────────────────────────────────────

export async function handleGetGenres(params: URLSearchParams, env: Env): Promise<Response> {
  const [songRows, albumRows] = await Promise.all([
    env.DB.prepare(
      `SELECT genre AS value, COUNT(*) AS songCount
         FROM tracks WHERE genre IS NOT NULL AND genre != ''
        GROUP BY genre`
    ).all<{ value: string; songCount: number }>(),
    env.DB.prepare(
      `SELECT genre AS value, COUNT(*) AS albumCount
         FROM albums WHERE genre IS NOT NULL AND genre != ''
        GROUP BY genre`
    ).all<{ value: string; albumCount: number }>(),
  ]);

  const byGenre = new Map<string, { songCount: number; albumCount: number }>();
  for (const r of songRows.results) {
    byGenre.set(r.value, { songCount: r.songCount, albumCount: 0 });
  }
  for (const r of albumRows.results) {
    const entry = byGenre.get(r.value);
    if (entry) entry.albumCount = r.albumCount;
    else byGenre.set(r.value, { songCount: 0, albumCount: r.albumCount });
  }

  const genres = [...byGenre.entries()].sort(([a], [b]) =>
    a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0
  );

  const xml = genres
    .map(
      ([value, c]) =>
        `<genre songCount="${c.songCount}" albumCount="${c.albumCount}">${esc(value)}</genre>`
    )
    .join("");
  return respondDual(params, env, `<genres>${xml}</genres>`, {
    genres: {
      genre: genres.map(([value, c]) => ({
        value,
        songCount: c.songCount,
        albumCount: c.albumCount,
      })),
    },
  });
}

// ── getSongsByGenre ──────────────────────────────────────────────────────────

export async function handleGetSongsByGenre(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const genre = params.get("genre") ?? "";
  const count = intParam(params.get("count"), 10, 500);
  const offset = intParam(params.get("offset"), 0);
  const user = params.get("u") ?? "";

  const rows = await env.DB.prepare(
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE t.genre = ?
      ORDER BY t.artist_name COLLATE NOCASE, t.album_name COLLATE NOCASE, t.disc_number, t.track_number
      LIMIT ? OFFSET ?`
  )
    .bind(user, genre, count, offset)
    .all<AnnotatedTrack>();

  const xml = `<songsByGenre>${rows.results.map((t) => songXml(t, annOf(t))).join("")}</songsByGenre>`;
  return respondDual(params, env, xml, {
    songsByGenre: { song: rows.results.map((t) => songJson(t, annOf(t))) },
  });
}

// ── getRandomSongs ───────────────────────────────────────────────────────────
// Fix #3: genre/fromYear/toYear are bound, never interpolated.

export async function handleGetRandomSongs(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const size = intParam(params.get("size"), 10, 500);
  const genre = params.get("genre");
  const fromYear = params.get("fromYear");
  const toYear = params.get("toYear");
  const user = params.get("u") ?? "";

  let sql =
    `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
       FROM tracks t
       LEFT JOIN annotations ann
         ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
      WHERE 1 = 1`;
  const binds: unknown[] = [user];
  if (genre) {
    sql += " AND t.genre = ?";
    binds.push(genre);
  }
  if (fromYear) {
    sql += " AND t.year >= ?";
    binds.push(intParam(fromYear, 0));
  }
  if (toYear) {
    sql += " AND t.year <= ?";
    binds.push(intParam(toYear, 0));
  }
  sql += " ORDER BY RANDOM() LIMIT ?";
  binds.push(size);

  const rows = await env.DB.prepare(sql)
    .bind(...binds)
    .all<AnnotatedTrack>();

  const xml = `<randomSongs>${rows.results.map((t) => songXml(t, annOf(t))).join("")}</randomSongs>`;
  return respondDual(params, env, xml, {
    randomSongs: { song: rows.results.map((t) => songJson(t, annOf(t))) },
  });
}
