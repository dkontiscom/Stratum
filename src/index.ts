// SPDX-License-Identifier: MIT
// Stratum Worker entry. Two concerns, one Worker:
//   fetch     → Subsonic/OpenSubsonic API  (src/server — not wired yet)
//   scheduled → importer cron              (src/importer — wired)
import type { Env } from "./shared";
import { runImportBatch } from "./importer";
import { handleApiRequest } from "./server/router";

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/rest/")) {
      return handleApiRequest(request, env);
    }
    return new Response("Stratum: OpenSubsonic API at /rest/\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8" },
    });
  },

  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // One bounded, resumable importer unit per tick. waitUntil keeps it alive past the handler
    // return; failures are swallowed to a log so a bad tick never wedges the cron.
    ctx.waitUntil(
      runImportBatch(env)
        .then((r) => console.log("import tick", JSON.stringify(r)))
        .catch((err) => console.error("import tick failed", err))
    );
  },
};
