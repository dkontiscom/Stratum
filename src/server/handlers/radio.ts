// SPDX-License-Identifier: MIT
// Internet-radio handlers (Subsonic "internet radio" group):
//   getInternetRadioStations, createInternetRadioStation,
//   updateInternetRadioStation, deleteInternetRadioStation.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Authorization choice: stations are GLOBAL/shared library state, so READS are open to any
// authenticated user, while every MUTATION (create/update/delete) is ADMIN ONLY (error 50).
// Every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline).
import type { Env } from "../../shared";
import { respond, respondError, esc } from "../respond";
import { respondDual } from "../serialize";
import { isAdmin } from "./users";

/** Standard Subsonic "not authorized" error (code 50). */
function notAuthorized(params: URLSearchParams, env: Env): Response {
  return respondError(params, env, 50, "User is not authorized for the given operation");
}

// ── Serialization ────────────────────────────────────────────────────────────

interface RadioRow {
  id: string;
  name: string;
  stream_url: string;
  homepage_url: string | null;
}

/** Self-closing `<internetRadioStation …/>`. homePageUrl is omitted when null. */
function stationXml(r: RadioRow): string {
  const home = r.homepage_url ? ` homePageUrl="${esc(r.homepage_url)}"` : "";
  return `<internetRadioStation id="${esc(r.id)}" name="${esc(r.name)}" streamUrl="${esc(r.stream_url)}"${home}/>`;
}

function stationJson(r: RadioRow): Record<string, unknown> {
  const o: Record<string, unknown> = { id: r.id, name: r.name, streamUrl: r.stream_url };
  if (r.homepage_url) o.homePageUrl = r.homepage_url;
  return o;
}

// ── getInternetRadioStations ─────────────────────────────────────────────────
// Any authenticated user may list the (global) stations.

export async function handleGetInternetRadioStations(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const rows = await env.DB.prepare(
    "SELECT id, name, stream_url, homepage_url FROM internet_radio_stations ORDER BY name COLLATE NOCASE"
  ).all<RadioRow>();

  const xml = `<internetRadioStations>${rows.results.map(stationXml).join("")}</internetRadioStations>`;
  return respondDual(params, env, xml, {
    internetRadioStations: { internetRadioStation: rows.results.map(stationJson) },
  });
}

// ── createInternetRadioStation (ADMIN ONLY) ──────────────────────────────────
// params: streamUrl, name, optional homepageUrl. id via crypto.randomUUID().

export async function handleCreateInternetRadioStation(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  if (!(await isAdmin(env, params.get("u") ?? ""))) return notAuthorized(params, env);

  const streamUrl = params.get("streamUrl");
  const name = params.get("name");
  if (!streamUrl || !name) {
    return respondError(params, env, 10, "Missing parameter: streamUrl and name are required");
  }

  const id = crypto.randomUUID();
  await env.DB.prepare(
    "INSERT INTO internet_radio_stations (id, name, stream_url, homepage_url) VALUES (?, ?, ?, ?)"
  )
    .bind(id, name, streamUrl, params.get("homepageUrl"))
    .run();
  return respond(params, env, "");
}

// ── updateInternetRadioStation (ADMIN ONLY) ──────────────────────────────────
// params: id (required), streamUrl, name, optional homepageUrl. Only the provided fields
// are updated (each value bound).

export async function handleUpdateInternetRadioStation(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  if (!(await isAdmin(env, params.get("u") ?? ""))) return notAuthorized(params, env);

  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  // The target must exist (error 70). Placed after the admin gate (50) and missing-param (10)
  // so the "non-admin update" test still sees 50 and existence isn't leaked to unauthorized callers.
  const exists = await env.DB.prepare("SELECT 1 AS x FROM internet_radio_stations WHERE id = ?")
    .bind(id)
    .first();
  if (!exists) return respondError(params, env, 70, "Internet radio station not found");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const name = params.get("name");
  if (name !== null) {
    sets.push("name = ?");
    binds.push(name);
  }
  const streamUrl = params.get("streamUrl");
  if (streamUrl !== null) {
    sets.push("stream_url = ?");
    binds.push(streamUrl);
  }
  const homepageUrl = params.get("homepageUrl");
  if (homepageUrl !== null) {
    sets.push("homepage_url = ?");
    binds.push(homepageUrl);
  }

  if (sets.length) {
    binds.push(id);
    await env.DB.prepare(`UPDATE internet_radio_stations SET ${sets.join(", ")} WHERE id = ?`)
      .bind(...binds)
      .run();
  }
  return respond(params, env, "");
}

// ── deleteInternetRadioStation (ADMIN ONLY) ──────────────────────────────────
// param: id.

export async function handleDeleteInternetRadioStation(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  if (!(await isAdmin(env, params.get("u") ?? ""))) return notAuthorized(params, env);

  const id = params.get("id");
  if (!id) return respondError(params, env, 10, "Missing parameter: id");

  await env.DB.prepare("DELETE FROM internet_radio_stations WHERE id = ?").bind(id).run();
  return respond(params, env, "");
}
