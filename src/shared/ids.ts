// SPDX-License-Identifier: MIT
//
// THE ID CONTRACT — the single source of truth for how library ids are generated.
// Server and importer MUST both go through these functions. If ids are ever generated
// differently anywhere, stars/ratings/playlists (which reference ids) silently break and
// duplicate rows appear. This was the original project's worst bug; keep it centralized.
//
// Tradeoff chosen: track identity is PATH-STEM based → stable across re-tagging, but a
// moved/renamed file is treated as a new track (its stars/playlist refs don't follow). This
// matches a "retag often, move rarely" workflow. Change it only deliberately, here, once.

/** SHA-256 → first 24 hex chars. Async (WebCrypto). */
export async function stableId(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 24);
}

/** Normalize a name for hashing only (display names are stored verbatim elsewhere). */
export function normalizeName(name: string): string {
  return (name ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

/**
 * Normalize an object key to its "stem": drop a leading slash, lowercase, and strip the
 * extension from the final path segment so `A/B/01.flac` and `A/B/01.mp3` share a track id.
 */
export function pathStem(key: string): string {
  const k = (key ?? "").replace(/^\/+/, "");
  const slash = k.lastIndexOf("/");
  const dir = slash >= 0 ? k.slice(0, slash + 1) : "";
  const base = slash >= 0 ? k.slice(slash + 1) : k;
  const dot = base.lastIndexOf(".");
  const stem = dot > 0 ? base.slice(0, dot) : base;
  return (dir + stem).toLowerCase();
}

export const artistId = (name: string) => stableId(`artist:${normalizeName(name)}`);

export const albumId = (artistName: string, albumName: string) =>
  stableId(`album:${normalizeName(artistName)}:${normalizeName(albumName)}`);

/** @param key the object key of any file belonging to the track (extension is ignored). */
export const trackId = (key: string) => stableId(`track:${pathStem(key)}`);

/** Physical-file id: exact backend+key (NOT normalized — distinct copies are distinct rows). */
export const trackFileId = (backendId: string, key: string) => stableId(`${backendId}:${key}`);
