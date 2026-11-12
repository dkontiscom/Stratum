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

/** Uniform handler shape; later slices register more entries the same way. */
type Handler = (params: URLSearchParams, env: Env) => Promise<Response>;

const ROUTES: Record<string, Handler> = {
  ping: handlePing,
  getLicense: handleGetLicense,
  getOpenSubsonicExtensions: handleGetOpenSubsonicExtensions,
};

/** Merge a POST body (JSON or form-encoded) into the query params. */
async function mergeBody(request: Request, params: URLSearchParams): Promise<void> {
  if (request.method !== "POST") return;
  try {
    const ct = request.headers.get("content-type") ?? "";
    const body = await request.text();
    const parsed: [string, string][] = ct.includes("application/json")
      ? Object.entries(JSON.parse(body) as Record<string, unknown>).map(
          ([k, v]) => [k, String(v)] as [string, string]
        )
      : [...new URLSearchParams(body).entries()];
    for (const [k, v] of parsed) params.set(k, v);
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
  // Expose the authenticated username to handlers (e.g. apiKey auth sets no `u`).
  if (!params.get("u") && auth.username) params.set("u", auth.username);

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
