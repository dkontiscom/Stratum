// SPDX-License-Identifier: MIT
// System / handshake handlers: ping, getLicense, getOpenSubsonicExtensions.
// All take the uniform handler signature (params, env) => Promise<Response> so the
// router can register later slices' handlers the same way.
import type { Env } from "../../shared";
import { respond, jsonResponse } from "../respond";

/** ping — liveness check; empty successful envelope. */
export async function handlePing(params: URLSearchParams, env: Env): Promise<Response> {
  return respond(params, env, {});
}

/** getLicense — always a valid, never-expiring license. */
export async function handleGetLicense(params: URLSearchParams, env: Env): Promise<Response> {
  const fmt = params.get("f") ?? "xml";
  if (fmt === "xml") {
    return respond(
      params,
      env,
      '<license valid="true" email="admin@stratum" licenseExpires="2099-01-01T00:00:00"/>'
    );
  }
  return respond(params, env, {
    license: { valid: true, email: "admin@stratum", licenseExpires: "2099-01-01T00:00:00" },
  });
}

/**
 * getOpenSubsonicExtensions — advertise supported OpenSubsonic extensions.
 * Ported as-is from the old server, which always answers JSON regardless of `f`
 * (this endpoint is an OpenSubsonic/JSON concern).
 */
export async function handleGetOpenSubsonicExtensions(
  _params: URLSearchParams,
  env: Env
): Promise<Response> {
  return jsonResponse(env, {
    openSubsonicExtensions: [
      { name: "formPost", versions: [1] },
      { name: "songLyrics", versions: [1] },
      { name: "apiKeyAuthentication", versions: [1] },
      { name: "transcodeOffset", versions: [1] },
      { name: "playbackReport", versions: [1] },
      { name: "songSimilarity", versions: [1] },
      { name: "indexBasedQueue", versions: [1] },
    ],
  });
}
