// SPDX-License-Identifier: MIT
//
// SCAN stage: enumerate each enabled backend's bucket into `import_worklist`, one page per
// backend per tick. Resumable — the ListObjectsV2 continuation token is parked in `meta` under
// `scan:cursor:<backendId>`, and `scan:done:<backendId>` marks a finished pass. Only audio keys
// are enqueued; a key whose size changed since last time is reset to 'pending' for re-ingest.
//
// Returns the number of S3 list requests issued, so the caller can keep the per-tick
// subrequest budget in check.

import type { Env, StorageBackendRow } from "../shared/types";
import { loadBackends, resolveS3Config } from "../shared/backends";
import { listObjectsPage } from "../shared/s3";
import { isAudioKey } from "../shared/media";

const PAGE_SIZE = 1000; // ListObjectsV2 max

export async function getMeta(env: Env, key: string): Promise<string | null> {
  const row = await env.DB.prepare("SELECT value FROM meta WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}
export async function setMeta(env: Env, key: string, value: string): Promise<void> {
  await env.DB.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).bind(key, value).run();
}
export async function delMeta(env: Env, key: string): Promise<void> {
  await env.DB.prepare("DELETE FROM meta WHERE key = ?").bind(key).run();
}

/** Enqueue one page of audio keys for a single backend. Returns true if more pages remain. */
async function scanBackendPage(env: Env, backend: StorageBackendRow): Promise<boolean> {
  const cfg = resolveS3Config(env, backend);
  const token = (await getMeta(env, `scan:cursor:${backend.id}`)) ?? undefined;
  const { objects, nextToken } = await listObjectsPage(cfg, { continuationToken: token, maxKeys: PAGE_SIZE });

  const audio = objects.filter((o) => isAudioKey(o.key));
  if (audio.length > 0) {
    // Insert as pending; if the row exists with a different size, reset it to pending so the
    // changed file is re-ingested. If size is unchanged, leave status alone (idempotent rescan).
    const stmt = env.DB.prepare(
      `INSERT INTO import_worklist (backend_id, key, status, size, updated_at)
       VALUES (?, ?, 'pending', ?, datetime('now'))
       ON CONFLICT(backend_id, key) DO UPDATE SET
         status = CASE WHEN import_worklist.size IS excluded.size THEN import_worklist.status ELSE 'pending' END,
         size   = excluded.size,
         updated_at = CASE WHEN import_worklist.size IS excluded.size THEN import_worklist.updated_at ELSE datetime('now') END`
    );
    // chunk to stay well under SQLite's variable limit (3 vars/row)
    const CHUNK = 200;
    for (let i = 0; i < audio.length; i += CHUNK) {
      await env.DB.batch(audio.slice(i, i + CHUNK).map((o) => stmt.bind(backend.id, o.key, o.size)));
    }
  }

  if (nextToken) {
    await setMeta(env, `scan:cursor:${backend.id}`, nextToken);
    return true;
  }
  await delMeta(env, `scan:cursor:${backend.id}`);
  await setMeta(env, `scan:done:${backend.id}`, new Date().toISOString());
  return false;
}

/**
 * Advance enumeration by one page for each backend that still has pages. `force` re-opens
 * finished backends (a fresh pass to pick up new/changed files).
 * @returns the number of S3 list requests issued this tick.
 */
export async function runScan(env: Env, opts: { force?: boolean } = {}): Promise<number> {
  const backends = await loadBackends(env);
  let requests = 0;
  for (const b of backends) {
    const done = await getMeta(env, `scan:done:${b.id}`);
    const hasCursor = await getMeta(env, `scan:cursor:${b.id}`);
    if (done && !hasCursor && !opts.force) continue; // finished; nothing to do unless forced
    if (opts.force && done && !hasCursor) await delMeta(env, `scan:done:${b.id}`);
    try {
      await scanBackendPage(env, b);
    } catch (err) {
      // leave the cursor as-is so the next tick retries this page
      await setMeta(env, `scan:error:${b.id}`, String(err instanceof Error ? err.message : err));
    }
    requests++;
  }
  return requests;
}
