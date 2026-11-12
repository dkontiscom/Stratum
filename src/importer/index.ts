// SPDX-License-Identifier: MIT
//
// Importer entry: one bounded unit of work per cron tick. Each tick advances enumeration by a
// page per backend, then ingests a batch of pending files. Both stages are resumable via D1
// (`meta` cursors for scan, `import_worklist` status for ingest), so the cron can be killed and
// restarted at any point and simply continues. Sized to stay inside the Workers free tier:
// external subrequests (S3 list + range GETs) are capped per tick.

import type { Env } from "../shared/types";
import { runScan } from "./scan";
import { runIngest } from "./ingest";

// Keep comfortably under the free-tier 50 external-subrequests/invocation ceiling.
const SUBREQUEST_BUDGET = 45;
// Upper bound on files ingested per tick (guards CPU time, independent of the budget).
const MAX_INGEST_PER_TICK = 20;

export interface ImportResult {
  scanRequests: number;
  ingested: number;
  ingestRequests: number;
}

export async function runImportBatch(env: Env, opts: { forceRescan?: boolean } = {}): Promise<ImportResult> {
  // 1) advance enumeration (one list page per backend that still has pages)
  const scanRequests = await runScan(env, { force: opts.forceRescan });

  // 2) spend the remaining subrequest budget ingesting pending files
  const ingestLimit = Math.max(0, Math.min(MAX_INGEST_PER_TICK, SUBREQUEST_BUDGET - scanRequests));
  const { processed, requests } = ingestLimit > 0 ? await runIngest(env, ingestLimit) : { processed: 0, requests: 0 };

  return { scanRequests, ingested: processed, ingestRequests: requests };
}

export { runScan, runIngest };
