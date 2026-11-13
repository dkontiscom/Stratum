// SPDX-License-Identifier: MIT
// Library-scan handlers (Subsonic "scan" group): getScanStatus, startScan.
//
// These endpoints are wired to the IMPORTER, which actually enumerates backends and ingests
// tracks on the SCHEDULED (cron) handler — never inline here. The importer parks its progress
// in `meta` (scan cursors under `scan:cursor:<backend>`, completion under `scan:done:<backend>`)
// and queues per-object work in `import_worklist` (status 'pending' until processed).
//
// So:
//   * `scanning` is true when any `import_worklist` row is still 'pending' (work queued for
//     the next cron tick) OR an enabled backend lacks a `scan:done:<id>` flag (a pass is
//     still needed), and `count` is the total number of ingested `tracks`;
//   * `startScan` does NOT scan synchronously — it clears the importer's per-backend
//     completion flags (`scan:done:*`) and mid-scan cursors (`scan:cursor:*`) so the next
//     cron tick re-enumerates every backend from the top, then returns the current
//     scanStatus (which reports scanning=true immediately, as scan:done is now absent).
import type { Env } from "../../shared";
import { respondError } from "../respond";
import { respondDual } from "../serialize";
import { isAdmin } from "./users";

/** Build the shared `<scanStatus …/>` response from current importer/library state. */
async function scanStatusResponse(params: URLSearchParams, env: Env): Promise<Response> {
  // A scan is in progress if EITHER there is queued work still 'pending', OR an enabled
  // backend has no `scan:done:<id>` flag (a pass is pending/needed — e.g. right after
  // startScan cleared the flags, before the next cron tick has enqueued anything). Once the
  // cron pass finishes it re-sets scan:done and drains the worklist, so this self-resolves.
  const pending = await env.DB.prepare(
    "SELECT 1 AS x FROM import_worklist WHERE status = 'pending' LIMIT 1"
  ).first<{ x: number }>();
  const needsScan = await env.DB.prepare(
    `SELECT 1 AS x FROM storage_backends sb
      WHERE sb.enabled = 1
        AND NOT EXISTS (SELECT 1 FROM meta m WHERE m.key = 'scan:done:' || sb.id)
      LIMIT 1`
  ).first<{ x: number }>();
  const scanning = !!pending || !!needsScan;

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

  // Clear per-backend completion flags so the cron importer re-enumerates everything, AND
  // clear any mid-scan cursors so a backend caught mid-pass restarts from the top rather than
  // resuming from its parked continuation token. Both literals are constants, not user input.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM meta WHERE key LIKE 'scan:done:%'"),
    env.DB.prepare("DELETE FROM meta WHERE key LIKE 'scan:cursor:%'"),
  ]);

  return scanStatusResponse(params, env);
}
