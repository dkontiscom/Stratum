// SPDX-License-Identifier: MIT
// Search handlers: search3 (ID3/tag-based) and search2 (folder-based alias).
//
// Both match a `%query%` LIKE across artists, albums and songs. Every value is bound
// (fix #3 — no interpolation), artist album counts are computed (fix #5), and per-user
// stars/ratings are LEFT JOINed from `annotations` for the authenticated user.
import type { Env } from "../../shared";
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

interface ArtistSearchRow {
  id: string;
  name: string;
  image_url: string | null;
  album_count: number;
  starred_at: string | null;
}

interface SearchHits {
  artists: ArtistListItem[];
  albums: AnnotatedAlbum[];
  songs: AnnotatedTrack[];
}

/** Run the three LIKE queries (artists/albums/songs) with bound params. */
async function runSearch(
  env: Env,
  user: string,
  query: string,
  counts: {
    artistCount: number;
    artistOffset: number;
    albumCount: number;
    albumOffset: number;
    songCount: number;
    songOffset: number;
  }
): Promise<SearchHits> {
  const like = `%${query}%`;

  const [artists, albums, songs] = await Promise.all([
    env.DB.prepare(
      `SELECT ar.id, ar.name, ar.image_url,
              (SELECT COUNT(*) FROM albums WHERE artist_id = ar.id) AS album_count,
              ann.starred_at AS starred_at
         FROM artists ar
         LEFT JOIN annotations ann
           ON ann.user = ? AND ann.item_type = 'artist' AND ann.item_id = ar.id
        WHERE ar.name LIKE ?
        ORDER BY ar.name COLLATE NOCASE
        LIMIT ? OFFSET ?`
    )
      .bind(user, like, counts.artistCount, counts.artistOffset)
      .all<ArtistSearchRow>(),
    env.DB.prepare(
      `SELECT al.*, ann.starred_at AS _starred, ann.rating AS _rating
         FROM albums al
         LEFT JOIN annotations ann
           ON ann.user = ? AND ann.item_type = 'album' AND ann.item_id = al.id
        WHERE al.name LIKE ? OR al.artist_name LIKE ?
        ORDER BY al.name COLLATE NOCASE
        LIMIT ? OFFSET ?`
    )
      .bind(user, like, like, counts.albumCount, counts.albumOffset)
      .all<AnnotatedAlbum>(),
    env.DB.prepare(
      `SELECT t.*, ann.starred_at AS _starred, ann.rating AS _rating
         FROM tracks t
         LEFT JOIN annotations ann
           ON ann.user = ? AND ann.item_type = 'track' AND ann.item_id = t.id
        WHERE t.title LIKE ? OR t.artist_name LIKE ? OR t.album_name LIKE ?
        ORDER BY t.title COLLATE NOCASE
        LIMIT ? OFFSET ?`
    )
      .bind(user, like, like, like, counts.songCount, counts.songOffset)
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

function searchXml(wrapper: string, hits: SearchHits): string {
  return (
    `<${wrapper}>` +
    hits.artists.map((a) => artistXml(a)).join("") +
    hits.albums.map((a) => albumXml(a, annOf(a))).join("") +
    hits.songs.map((t) => songXml(t, annOf(t))).join("") +
    `</${wrapper}>`
  );
}

function searchJson(hits: SearchHits): object {
  return {
    artist: hits.artists.map(artistJson),
    album: hits.albums.map((a) => albumJson(a, annOf(a))),
    song: hits.songs.map((t) => songJson(t, annOf(t))),
  };
}

export async function handleSearch3(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const hits = await runSearch(env, user, params.get("query") ?? "", {
    artistCount: intParam(params.get("artistCount"), 20),
    artistOffset: intParam(params.get("artistOffset"), 0),
    albumCount: intParam(params.get("albumCount"), 20),
    albumOffset: intParam(params.get("albumOffset"), 0),
    songCount: intParam(params.get("songCount"), 20),
    songOffset: intParam(params.get("songOffset"), 0),
  });
  return respondDual(params, env, searchXml("searchResult3", hits), {
    searchResult3: searchJson(hits),
  });
}

export async function handleSearch2(params: URLSearchParams, env: Env): Promise<Response> {
  const user = params.get("u") ?? "";
  const hits = await runSearch(env, user, params.get("query") ?? "", {
    artistCount: intParam(params.get("artistCount"), 20),
    artistOffset: intParam(params.get("artistOffset"), 0),
    albumCount: intParam(params.get("albumCount"), 20),
    albumOffset: intParam(params.get("albumOffset"), 0),
    songCount: intParam(params.get("songCount"), 20),
    songOffset: intParam(params.get("songOffset"), 0),
  });
  return respondDual(params, env, searchXml("searchResult2", hits), {
    searchResult2: searchJson(hits),
  });
}
