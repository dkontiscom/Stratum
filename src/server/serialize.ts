// SPDX-License-Identifier: MIT
// Shared row→response serializers for the browsing/search slice.
//
// Every entity has a JSON builder and an XML-fragment builder so the handlers stay
// format-agnostic: a handler assembles the DB rows, then emits either the XML string
// or the JSON object depending on the `f` param (via respondDual below).
//
// coverArt convention: the ALBUM id is the coverArt id for BOTH albums and songs
// (getCoverArt, a later slice, resolves that id to cover_backend_id/cover_key). We do
// NOT read cover_key here. Artists advertise their own id as coverArt (matches search).
import type { AlbumRow, Env, TrackRow } from "../shared";
import { esc, respond } from "./respond";

// ── Per-user annotation (stars + ratings) ────────────────────────────────────

/** Star/rating state for the current user, joined from `annotations`. */
export interface Annotation {
  starred?: string | null; // starred_at (ISO timestamp) or null when not starred
  rating?: number | null; // 1..5 or null when unrated
}

/** A joined row carries the current user's annotation under these aliases. */
export interface AnnotationCols {
  _starred?: string | null;
  _rating?: number | null;
}

/** Pull the Annotation out of a row that LEFT JOINed `annotations` for the user. */
export function annOf(row: AnnotationCols): Annotation {
  return { starred: row._starred ?? null, rating: row._rating ?? null };
}

// ── Row shapes (schema columns the serializers read) ─────────────────────────
// AlbumRow/TrackRow in shared/types.ts omit created_at (not part of the importer's
// write surface), but the API serves it as `created`, so we widen locally.

/** Album row + created_at, optionally annotated for the current user. */
export type AlbumRecord = AlbumRow & { created_at?: string | null };
/** Track row + created_at, optionally annotated for the current user. */
export type TrackRecord = TrackRow & { created_at?: string | null };
export type AnnotatedAlbum = AlbumRecord & AnnotationCols;
export type AnnotatedTrack = TrackRecord & AnnotationCols;

/** Artist list item with a REAL album count (never hardcoded to 0, see fix #5). */
export interface ArtistListItem {
  id: string;
  name: string;
  album_count: number;
  image_url?: string | null;
  starred_at?: string | null;
}

// ── Format dispatch helper ───────────────────────────────────────────────────

/**
 * Emit a successful response in the client's format. `respond()` uses only the XML
 * string on the xml path and only the data object on json/jsonp, so handlers build
 * both and this picks the right one.
 */
export function respondDual(
  params: URLSearchParams,
  env: Env,
  xml: string,
  data: object
): Response {
  const fmt = params.get("f") ?? "xml";
  return fmt === "xml" ? respond(params, env, xml) : respond(params, env, data);
}

// ── Artist ───────────────────────────────────────────────────────────────────

export function artistJson(a: ArtistListItem): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: a.id,
    name: a.name,
    albumCount: a.album_count,
    coverArt: a.id,
  };
  if (a.starred_at) o.starred = a.starred_at;
  return o;
}

/** Self-closing `<artist …/>` (or another tag, e.g. inside an index). */
export function artistXml(a: ArtistListItem, tag = "artist"): string {
  const starred = a.starred_at ? ` starred="${esc(a.starred_at)}"` : "";
  return `<${tag} id="${esc(a.id)}" name="${esc(a.name)}" albumCount="${a.album_count}" coverArt="${esc(a.id)}"${starred}/>`;
}

// ── Album (albumList / album child shape) ────────────────────────────────────

export function albumJson(a: AlbumRecord, ann?: Annotation): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: a.id,
    name: a.name,
    artist: a.artist_name,
    artistId: a.artist_id,
    coverArt: a.id,
    songCount: a.song_count,
    duration: a.duration,
  };
  if (a.year != null) o.year = a.year;
  if (a.genre) o.genre = a.genre;
  if (a.created_at) o.created = a.created_at;
  if (ann?.starred) o.starred = ann.starred;
  if (ann?.rating != null) o.userRating = ann.rating;
  return o;
}

/**
 * `<album …>${children}</album>`. Pass children="" for a leaf album (list entry);
 * pass serialized `<song/>` fragments for getAlbum.
 */
export function albumXml(a: AlbumRecord, ann?: Annotation, children = ""): string {
  const parts = [
    `id="${esc(a.id)}"`,
    `name="${esc(a.name)}"`,
    `artist="${esc(a.artist_name)}"`,
    `artistId="${esc(a.artist_id)}"`,
    `coverArt="${esc(a.id)}"`,
    `songCount="${a.song_count}"`,
    `duration="${a.duration}"`,
  ];
  if (a.year != null) parts.push(`year="${a.year}"`);
  if (a.genre) parts.push(`genre="${esc(a.genre)}"`);
  if (a.created_at) parts.push(`created="${esc(a.created_at)}"`);
  if (ann?.starred) parts.push(`starred="${esc(ann.starred)}"`);
  if (ann?.rating != null) parts.push(`userRating="${ann.rating}"`);
  return `<album ${parts.join(" ")}>${children}</album>`;
}

// ── Song (Subsonic "child") ──────────────────────────────────────────────────

export function songJson(t: TrackRecord, ann?: Annotation): Record<string, unknown> {
  const o: Record<string, unknown> = {
    id: t.id,
    parent: t.album_id,
    isDir: false,
    title: t.title,
    album: t.album_name,
    artist: t.artist_name,
    coverArt: t.album_id,
    size: t.size ?? 0,
    contentType: t.content_type ?? "audio/mpeg",
    suffix: t.suffix ?? "",
    duration: t.duration,
    bitRate: t.bit_rate ?? 0,
    albumId: t.album_id,
    artistId: t.artist_id,
    type: "music",
    discNumber: t.disc_number ?? 1,
  };
  if (t.track_number != null) o.track = t.track_number;
  if (t.year != null) o.year = t.year;
  if (t.genre) o.genre = t.genre;
  if (t.created_at) o.created = t.created_at;
  if (ann?.starred) o.starred = ann.starred;
  if (ann?.rating != null) o.userRating = ann.rating;
  return o;
}

/** Self-closing `<song …/>`; pass tag="child" for folder-browsing responses. */
export function songXml(t: TrackRecord, ann?: Annotation, tag = "song"): string {
  const parts = [
    `id="${esc(t.id)}"`,
    `parent="${esc(t.album_id)}"`,
    `isDir="false"`,
    `title="${esc(t.title)}"`,
    `album="${esc(t.album_name)}"`,
    `artist="${esc(t.artist_name)}"`,
    `coverArt="${esc(t.album_id)}"`,
    `size="${t.size ?? 0}"`,
    `contentType="${esc(t.content_type ?? "audio/mpeg")}"`,
    `suffix="${esc(t.suffix ?? "")}"`,
    `duration="${t.duration}"`,
    `bitRate="${t.bit_rate ?? 0}"`,
    `albumId="${esc(t.album_id)}"`,
    `artistId="${esc(t.artist_id)}"`,
    `type="music"`,
    `discNumber="${t.disc_number ?? 1}"`,
  ];
  if (t.track_number != null) parts.push(`track="${t.track_number}"`);
  if (t.year != null) parts.push(`year="${t.year}"`);
  if (t.genre) parts.push(`genre="${esc(t.genre)}"`);
  if (t.created_at) parts.push(`created="${esc(t.created_at)}"`);
  if (ann?.starred) parts.push(`starred="${esc(ann.starred)}"`);
  if (ann?.rating != null) parts.push(`userRating="${ann.rating}"`);
  return `<${tag} ${parts.join(" ")}/>`;
}

// ── Small parse helpers ──────────────────────────────────────────────────────

/** Parse an int param with a default and an optional inclusive max (floored at 0). */
export function intParam(value: string | null, def: number, max?: number): number {
  const n = parseInt(value ?? "", 10);
  let x = Number.isFinite(n) ? n : def;
  if (x < 0) x = 0;
  if (max != null && x > max) x = max;
  return x;
}
