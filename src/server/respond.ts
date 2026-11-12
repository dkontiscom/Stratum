// SPDX-License-Identifier: MIT
// Subsonic/OpenSubsonic response envelope.
//
// The response format is chosen by the `f` query param: "xml" (default), "json",
// or "jsonp". Every envelope carries the OpenSubsonic fields (type/serverVersion/
// openSubsonic) alongside the classic status/version. Non-secret config (server
// name, API version) comes from the Worker `vars`, read off `env`.
import type { Env } from "../shared";

/** Server implementation version reported as `serverVersion`. */
const SERVER_VERSION = "0.1.0";

/** Read a string-valued Worker var, falling back when unset/non-string. */
function envStr(env: Env, key: string, fallback: string): string {
  const val = env[key];
  return typeof val === "string" && val.length > 0 ? val : fallback;
}

function apiVersion(env: Env): string {
  return envStr(env, "SUBSONIC_API_VERSION", "1.16.1");
}

function serverType(env: Env): string {
  return envStr(env, "SERVER_NAME", "stratum");
}

// ── XML ─────────────────────────────────────────────────────────────────────

function xmlResponse(env: Env, body: string): Response {
  const version = apiVersion(env);
  const type = esc(serverType(env));
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="ok" version="${version}" type="${type}" serverVersion="${SERVER_VERSION}" openSubsonic="true">${body}</subsonic-response>`,
    { headers: { "Content-Type": "text/xml; charset=utf-8" } }
  );
}

function errorXml(env: Env, code: number, message: string): Response {
  const version = apiVersion(env);
  return new Response(
    `<?xml version="1.0" encoding="UTF-8"?>\n<subsonic-response xmlns="http://subsonic.org/restapi" status="failed" version="${version}" type="${esc(serverType(env))}" serverVersion="${SERVER_VERSION}" openSubsonic="true"><error code="${code}" message="${esc(message)}"/></subsonic-response>`,
    { headers: { "Content-Type": "text/xml; charset=utf-8" } }
  );
}

// ── JSON ────────────────────────────────────────────────────────────────────

function jsonEnvelope(env: Env, data: object): object {
  return {
    "subsonic-response": {
      status: "ok",
      version: apiVersion(env),
      type: serverType(env),
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      ...data,
    },
  };
}

function jsonErrorEnvelope(env: Env, code: number, message: string): object {
  return {
    "subsonic-response": {
      status: "failed",
      version: apiVersion(env),
      type: serverType(env),
      serverVersion: SERVER_VERSION,
      openSubsonic: true,
      error: { code, message },
    },
  };
}

export function jsonResponse(env: Env, data: object): Response {
  return new Response(JSON.stringify(jsonEnvelope(env, data)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function errorJson(env: Env, code: number, message: string): Response {
  return new Response(JSON.stringify(jsonErrorEnvelope(env, code, message)), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// JSONP: wrap the JSON body as `<callback>(<json>);` with a JS content-type.
// FIX (#5): the old code never wrapped jsonp — it fell through to plain json and
// lost the callback entirely. We now honour the `callback` param. If f=jsonp but
// no `callback` is supplied, we fall back to plain json (the only safe choice).
function jsonpResponse(env: Env, params: URLSearchParams, data: object): Response {
  const callback = params.get("callback");
  if (!callback) return jsonResponse(env, data);
  const body = JSON.stringify(jsonEnvelope(env, data));
  return new Response(`${callback}(${body});`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

function jsonpError(env: Env, params: URLSearchParams, code: number, message: string): Response {
  const callback = params.get("callback");
  if (!callback) return errorJson(env, code, message);
  const body = JSON.stringify(jsonErrorEnvelope(env, code, message));
  return new Response(`${callback}(${body});`, {
    headers: { "Content-Type": "application/javascript; charset=utf-8" },
  });
}

// ── Dispatch by format ────────────────────────────────────────────────────────

/**
 * Build a successful response in the client's requested format.
 * Pass an XML fragment (string) for the xml path and a data object for json/jsonp;
 * each format uses only the payload that applies to it.
 */
export function respond(params: URLSearchParams, env: Env, xml: string): Response;
export function respond(params: URLSearchParams, env: Env, data: object): Response;
export function respond(params: URLSearchParams, env: Env, payload: string | object): Response {
  const fmt = params.get("f") ?? "xml";
  const data = typeof payload === "string" ? {} : payload;
  if (fmt === "json") return jsonResponse(env, data);
  if (fmt === "jsonp") return jsonpResponse(env, params, data);
  return xmlResponse(env, typeof payload === "string" ? payload : "");
}

/** Build a Subsonic error response in the client's requested format. */
export function respondError(
  params: URLSearchParams,
  env: Env,
  code: number,
  message: string
): Response {
  const fmt = params.get("f") ?? "xml";
  if (fmt === "json") return errorJson(env, code, message);
  if (fmt === "jsonp") return jsonpError(env, params, code, message);
  return errorXml(env, code, message);
}

// ── Serializer helper ──────────────────────────────────────────────────────────

/** Escape a value for inclusion in XML attribute/text content. */
export function esc(s: string | null | undefined): string {
  if (!s) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
