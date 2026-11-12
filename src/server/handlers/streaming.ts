// SPDX-License-Identifier: MIT
// Streaming + cover-art handlers (Subsonic "media retrieval" group):
//   stream, download, getCoverArt.
//
// ARCHITECTURAL CORE: the Worker NEVER proxies audio (or image) bytes. It resolves a
// track to a physical file in some S3-compatible backend, presigns a short-lived GET
// URL, and 302-redirects the client straight to storage. The client then streams the
// bytes directly (and issues its own Range requests against the backend). No fetch()
// of media ever happens here — only presign + redirect.
import type { Env, StorageBackendRow } from "../../shared";
import { getBackend, presignGetUrl, resolveS3Config } from "../../shared";
import { respondError } from "../respond";

/** A resolved physical file: which enabled backend holds it, and the object key. */
interface ResolvedFile {
  backend: StorageBackendRow;
  key: string;
}

/**
 * Pick the best physical file for a track across all ENABLED backends.
 *
 * Ordering (most-preferred first):
 *   1. is_original DESC   — the source file wins (so download gets the original too)
 *   2. backend priority ASC — lower priority number = more preferred backend
 *   3. format rank        — flac (0) > mp3 (1) > anything else (2)
 *
 * Returns the full StorageBackendRow so the caller can resolveS3Config() it, or null
 * if the track has no file on any enabled backend.
 */
async function resolveBestFile(env: Env, trackId: string): Promise<ResolvedFile | null> {
  const row = await env.DB.prepare(
    `SELECT sb.*, tf.key AS _key
       FROM track_files tf
       JOIN storage_backends sb ON sb.id = tf.backend_id
      WHERE tf.track_id = ? AND sb.enabled = 1
      ORDER BY
        tf.is_original DESC,
        sb.priority ASC,
        CASE tf.format WHEN 'flac' THEN 0 WHEN 'mp3' THEN 1 ELSE 2 END ASC
      LIMIT 1`
  )
    .bind(trackId)
    .first<StorageBackendRow & { _key: string }>();
  if (!row) return null;

  const { _key, ...backend } = row;
  return { backend: backend as StorageBackendRow, key: _key };
}

/** Build the 302 redirect to a presigned storage URL (never proxies bytes). */
function redirect(url: string): Response {
  return new Response(null, { status: 302, headers: { Location: url } });
}

/**
 * Presign the resolved file and 302-redirect to it. Returns a Subsonic error response
 * instead if the backend's credentials can't be resolved (e.g. an R2-binding backend,
 * which resolveS3Config throws for — not wired in v1).
 */
async function redirectToFile(
  params: URLSearchParams,
  env: Env,
  file: ResolvedFile
): Promise<Response> {
  let cfg;
  try {
    cfg = resolveS3Config(env, file.backend);
  } catch {
    // resolveS3Config throws for R2-binding backends (no SigV4 path in v1) or missing
    // secrets. Fail gracefully rather than 500.
    return respondError(params, env, 0, "Streaming backend not available");
  }
  const url = await presignGetUrl(cfg, file.key);
  return redirect(url);
}

// ── stream ─────────────────────────────────────────────────────────────────────
// 302 to a presigned URL for the best available file of the given track.

export async function handleStream(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  // v1 has NO server-side transcoding: maxBitRate / format / estimateContentLength are
  // deliberately ignored, and we always serve the original file. This is a v1 limitation,
  // not an oversight — transcoding on a Worker (no ffmpeg) is out of scope.
  const file = await resolveBestFile(env, id);
  if (!file) return respondError(params, env, 70, "Song not found");

  return redirectToFile(params, env, file);
}

// ── download ─────────────────────────────────────────────────────────────────────
// Same resolution as stream; the ordering already prefers is_original, so download
// hands back the original source file.

export async function handleDownload(params: URLSearchParams, env: Env): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  const file = await resolveBestFile(env, id);
  if (!file) return respondError(params, env, 70, "Song not found");

  return redirectToFile(params, env, file);
}

// ── getCoverArt ─────────────────────────────────────────────────────────────────
// coverArt id convention (slice 2): albums AND songs use the ALBUM id; artists use
// their own id. We try albums first, then artists. The `size` param is ignored (no
// image resizing in v1).

export async function handleGetCoverArt(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  // 1. Album cover: a file in some backend. Presign + 302 if both pieces are present.
  const album = await env.DB.prepare(
    "SELECT cover_backend_id, cover_key FROM albums WHERE id = ?"
  )
    .bind(id)
    .first<{ cover_backend_id: string | null; cover_key: string | null }>();
  if (album && album.cover_backend_id && album.cover_key) {
    const backend = await getBackend(env, album.cover_backend_id);
    // Only serve from ENABLED backends, matching stream/download. A disabled (or
    // dangling) cover backend falls through to the artist/no-cover path.
    if (backend && backend.enabled) {
      let cfg;
      try {
        cfg = resolveS3Config(env, backend);
      } catch {
        return respondError(params, env, 0, "Cover art backend not available");
      }
      const url = await presignGetUrl(cfg, album.cover_key);
      return redirect(url);
    }
  }

  // 2. Artist image: an external URL. Redirect straight to it (no presign, no proxy).
  const artist = await env.DB.prepare(
    "SELECT image_url FROM artists WHERE id = ?"
  )
    .bind(id)
    .first<{ image_url: string | null }>();
  if (artist && artist.image_url) {
    return redirect(artist.image_url);
  }

  // 3. No cover art. Common in v1 (the importer doesn't populate album covers yet).
  return respondError(params, env, 70, "Cover art not found");
}
