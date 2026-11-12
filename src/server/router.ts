// SPDX-License-Identifier: MIT
// Subsonic API dispatcher.
//
// Requests arrive as `/rest/<method>` or `/rest/<method>.view`. Every method
// requires valid authentication (Subsonic has no public endpoints — ping and the
// handshake calls included), which matches the old server. On auth failure we
// return Subsonic error 40; on an unknown method, error 0.
import type { Env } from "../shared";
import { respondError } from "./respond";
import { checkAuth } from "./auth";
import {
  handlePing,
  handleGetLicense,
  handleGetOpenSubsonicExtensions,
} from "./handlers/system";
import {
  handleGetMusicFolders,
  handleGetIndexes,
  handleGetMusicDirectory,
  handleGetArtists,
  handleGetArtist,
  handleGetArtistInfo2,
  handleGetAlbum,
  handleGetAlbumInfo2,
  handleGetAlbumList2,
  handleGetAlbumList,
  handleGetSong,
  handleGetGenres,
  handleGetSongsByGenre,
  handleGetRandomSongs,
} from "./handlers/browsing";
import { handleSearch2, handleSearch3 } from "./handlers/search";
import {
  handleStream,
  handleDownload,
  handleGetCoverArt,
} from "./handlers/streaming";
import {
  handleStar,
  handleUnstar,
  handleSetRating,
  handleScrobble,
  handlePlaybackReport,
} from "./handlers/annotations";
import {
  handleGetStarred2,
  handleGetStarred,
  handleGetNowPlaying,
  handleGetTopSongs,
  handleGetSimilarSongs,
  handleGetSimilarSongs2,
  handleGetLyrics,
  handleGetLyricsBySongId,
} from "./handlers/personal";
import {
  handleGetPlaylists,
  handleGetPlaylist,
  handleCreatePlaylist,
  handleUpdatePlaylist,
  handleDeletePlaylist,
} from "./handlers/playlists";
import {
  handleSavePlayQueue,
  handleGetPlayQueue,
  handleCreateBookmark,
  handleGetBookmarks,
  handleDeleteBookmark,
} from "./handlers/queue";

/** Uniform handler shape; later slices register more entries the same way. */
type Handler = (params: URLSearchParams, env: Env) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  ping: handlePing,
  getLicense: handleGetLicense,
  getOpenSubsonicExtensions: handleGetOpenSubsonicExtensions,
  // Slice 2: browsing + lists
  getMusicFolders: handleGetMusicFolders,
  getIndexes: handleGetIndexes,
  getMusicDirectory: handleGetMusicDirectory,
  getArtists: handleGetArtists,
  getArtist: handleGetArtist,
  getArtistInfo2: handleGetArtistInfo2,
  getAlbum: handleGetAlbum,
  getAlbumInfo2: handleGetAlbumInfo2,
  getAlbumList2: handleGetAlbumList2,
  getAlbumList: handleGetAlbumList,
  getSong: handleGetSong,
  getGenres: handleGetGenres,
  getSongsByGenre: handleGetSongsByGenre,
  getRandomSongs: handleGetRandomSongs,
  // Slice 2: search
  search2: handleSearch2,
  search3: handleSearch3,
  // Slice 3: streaming + media retrieval (presign + 302, never byte-proxy)
  stream: handleStream,
  download: handleDownload,
  getCoverArt: handleGetCoverArt,
  // Slice 4: annotations (stars / ratings / scrobble)
  star: handleStar,
  unstar: handleUnstar,
  setRating: handleSetRating,
  scrobble: handleScrobble,
  playbackReport: handlePlaybackReport,
  // Slice 4: personal read-lists + lyrics
  getStarred2: handleGetStarred2,
  getStarred: handleGetStarred,
  getNowPlaying: handleGetNowPlaying,
  getTopSongs: handleGetTopSongs,
  getSimilarSongs: handleGetSimilarSongs,
  getSimilarSongs2: handleGetSimilarSongs2,
  getLyrics: handleGetLyrics,
  getLyricsBySongId: handleGetLyricsBySongId,
  // Slice 5: playlists
  getPlaylists: handleGetPlaylists,
  getPlaylist: handleGetPlaylist,
  createPlaylist: handleCreatePlaylist,
  updatePlaylist: handleUpdatePlaylist,
  deletePlaylist: handleDeletePlaylist,
  // Slice 5: play queue + bookmarks
  savePlayQueue: handleSavePlayQueue,
  getPlayQueue: handleGetPlayQueue,
  createBookmark: handleCreateBookmark,
  getBookmarks: handleGetBookmarks,
  deleteBookmark: handleDeleteBookmark,
};

/**
 * Merge a POST body (JSON or form-encoded) into the query params. Body values override
 * query values for the same key, but REPEATED keys are preserved: star/unstar/scrobble
 * carry many `id`/`albumId`/`artistId` and read them with getAll(), so we must not collapse
 * them to one (the formPost extension sends these in the body). For each key we delete the
 * query copy once, then append every body value. JSON array values expand to repeats too.
 */
async function mergeBody(request: Request, params: URLSearchParams): Promise<void> {
  if (request.method !== "POST") return;
  try {
    const ct = request.headers.get("content-type") ?? "";
    const pairs: [string, string][] = ct.includes("application/json")
      ? Object.entries(JSON.parse(await request.text()) as Record<string, unknown>).flatMap(
          ([k, v]) =>
            (Array.isArray(v) ? v : [v]).map((x) => [k, String(x)] as [string, string])
        )
      : [...new URLSearchParams(await request.text()).entries()];

    const seen = new Set<string>();
    for (const [k, v] of pairs) {
      if (!seen.has(k)) {
        params.delete(k); // drop any query-string copy once, then append body values
        seen.add(k);
      }
      params.append(k, v);
    }
  } catch {
    // Malformed body: ignore and auth on whatever query params we have.
  }
}

export async function handleApiRequest(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);

  const match = url.pathname.match(/\/rest\/([^./]+)/);
  if (!match) {
    return new Response("Not found", { status: 404 });
  }
  const method = match[1];

  const params = new URLSearchParams(url.search);
  await mergeBody(request, params);

  const auth = await checkAuth(params, env);
  if (!auth.ok) {
    return respondError(params, env, 40, "Wrong username or password");
  }
  // Always bind `u` to the AUTHENTICATED identity, overriding any client-supplied value.
  // Token/legacy auth already derive auth.username from `u` (no-op here); apiKey auth does
  // NOT, so without this override a caller could pass u=<another-user> and act on their data.
  if (auth.username) params.set("u", auth.username);

  const handler = ROUTES[method];
  if (!handler) {
    return respondError(params, env, 0, `Endpoint not implemented: ${method}`);
  }

  try {
    return await handler(params, env);
  } catch (err) {
    console.error(`Error in ${method}:`, err);
    return respondError(params, env, 0, "Internal server error");
  }
}
