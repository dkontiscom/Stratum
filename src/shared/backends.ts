// SPDX-License-Identifier: MIT
// Turn a storage_backends row + Worker secrets into usable config, and pick the right backend
// for a given track file. Keeps credential lookup (secret_ref convention) in one place.

import type { Env, StorageBackendRow } from "./types";
import type { S3Config } from "./s3";

/** Resolve a backend row's S3 credentials from env secrets via its secret_ref prefix. */
export function resolveS3Config(env: Env, row: StorageBackendRow): S3Config {
  if (!row.endpoint) throw new Error(`backend ${row.id}: missing endpoint`);
  const ref = row.secret_ref;
  if (!ref) throw new Error(`backend ${row.id}: missing secret_ref`);
  const accessKey = env[`${ref}_ACCESS_KEY`] as string | undefined;
  const secretKey = env[`${ref}_SECRET_KEY`] as string | undefined;
  if (!accessKey || !secretKey) throw new Error(`backend ${row.id}: secrets ${ref}_ACCESS_KEY/_SECRET_KEY not set`);
  return { endpoint: row.endpoint, region: row.region ?? "auto", bucket: row.bucket, accessKey, secretKey };
}

/** Load enabled backends from D1, lowest priority first (most preferred). */
export async function loadBackends(env: Env): Promise<StorageBackendRow[]> {
  const res = await env.DB.prepare(
    "SELECT * FROM storage_backends WHERE enabled = 1 ORDER BY priority ASC"
  ).all<StorageBackendRow>();
  return res.results ?? [];
}

export async function getBackend(env: Env, id: string): Promise<StorageBackendRow | null> {
  return env.DB.prepare("SELECT * FROM storage_backends WHERE id = ?").bind(id).first<StorageBackendRow>();
}

// NOTE: R2-binding backends (type === 'r2' with no endpoint) are a planned second path:
// read via `env[secret_ref]` as an R2Bucket binding (list/get), no SigV4. Not wired in v1;
// resolveS3Config throws for them until implemented so misconfiguration fails loudly.
