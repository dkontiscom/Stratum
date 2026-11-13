// SPDX-License-Identifier: MIT
// System / handshake handlers: ping, getLicense, getOpenSubsonicExtensions.
// All take the uniform handler signature (params, env) => Promise<Response> so the
// router can register later slices' handlers the same way.
import type { Env } from "../../shared";
import { respond, esc } from "../respond";
import { respondDual } from "../serialize";

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
 * Respects `f`: real OpenSubsonic clients send f=json and get the JSON shape;
 * f=xml (or no `f`) gets the equivalent XML form.
 */
export async function handleGetOpenSubsonicExtensions(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const extensions = [
    { name: "formPost", versions: [1] },
    { name: "songLyrics", versions: [1] },
    { name: "apiKeyAuthentication", versions: [1] },
    { name: "transcodeOffset", versions: [1] },
    { name: "playbackReport", versions: [1] },
    { name: "songSimilarity", versions: [1] },
    { name: "indexBasedQueue", versions: [1] },
  ];
  const xml = extensions
    .map(
      (ext) =>
        `<openSubsonicExtensions name="${esc(ext.name)}">${ext.versions
          .map((v) => `<versions>${v}</versions>`)
          .join("")}</openSubsonicExtensions>`
    )
    .join("");
  return respondDual(params, env, xml, { openSubsonicExtensions: extensions });
}
