// SPDX-License-Identifier: MIT
// Library-scan handlers (Subsonic "scan" group): getScanStatus, startScan.
//
// These endpoints are wired to the IMPORTER, which actually enumerates backends and ingests
// tracks on the SCHEDULED (cron) handler — never inline here. The importer parks its progress
// in `meta` (scan cursors under `scan:cursor:<backend>`, completion under `scan:done:<backend>`)
// and queues per-object work in `import_worklist` (status 'pending' until processed).
//
// So:
//   * `scanning` reflects whether any `import_worklist` row is still 'pending' (work queued
//     for the next cron tick), and `count` is the total number of ingested `tracks`;
//   * `startScan` does NOT scan synchronously — it clears the importer's per-backend
//     completion flags (`scan:done:*`) so the next cron tick re-enumerates every backend,
//     then returns the current scanStatus.
import type { Env } from "../../shared";
import { respondError } from "../respond";
import { respondDual } from "../serialize";
import { isAdmin } from "./users";

/** Build the shared `<scanStatus …/>` response from current importer/library state. */
async function scanStatusResponse(params: URLSearchParams, env: Env): Promise<Response> {
  const pending = await env.DB.prepare(
    "SELECT 1 AS x FROM import_worklist WHERE status = 'pending' LIMIT 1"
  ).first<{ x: number }>();
  const scanning = !!pending;

  const countRow = await env.DB.prepare("SELECT COUNT(*) AS c FROM tracks").first<{ c: number }>();
  const count = countRow?.c ?? 0;

  return respondDual(params, env, `<scanStatus scanning="${scanning}" count="${count}"/>`, {
    scanStatus: { scanning, count },
  });
}

// ── getScanStatus ────────────────────────────────────────────────────────────

export async function handleGetScanStatus(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  return scanStatusResponse(params, env);
}

// ── startScan (ADMIN ONLY) ───────────────────────────────────────────────────
// The real scan runs on the SCHEDULED (cron) importer, not inline. We force a full
// re-enumeration on the next cron tick by clearing the importer's completion flags; the
// 'scan:done:%' literal is a constant, not user input. We then report the current status.

export async function handleStartScan(params: URLSearchParams, env: Env): Promise<Response> {
  if (!(await isAdmin(env, params.get("u") ?? ""))) {
    return respondError(params, env, 50, "User is not authorized for the given operation");
  }

  // Clear per-backend completion flags so the cron importer re-enumerates everything.
  await env.DB.prepare("DELETE FROM meta WHERE key LIKE 'scan:done:%'").run();

  return scanStatusResponse(params, env);
}
