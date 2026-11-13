// SPDX-License-Identifier: MIT
// Shared test setup: schema application, a tiny seeded library, the env, and request
// drivers. The schema is imported as a raw string (Vite `?raw`) so there is no fixture
// to ship and no Node fs dependency inside the worker runtime.

import { env } from "cloudflare:test";
import { Md5 } from "ts-md5";
import schemaSql from "../schema/schema.sql?raw";
import { handleApiRequest } from "../src/server/router";
import type { Env } from "../src/shared";

/** Bootstrap admin password (a secret, so not present in wrangler vars — injected here). */
export const ADMIN_PASSWORD = "s3cret-admin";

/** Credentials for the seeded "garage-home" backend, keyed by its secret_ref prefix. */
export const GARAGE_ACCESS_KEY = "AKIAEXAMPLE";
export const GARAGE_SECRET_KEY = "secret-key-example";

export const testEnv = {
  ...(env as unknown as Env),
  ADMIN_PASSWORD,
  GARAGE_HOME_ACCESS_KEY: GARAGE_ACCESS_KEY,
  GARAGE_HOME_SECRET_KEY: GARAGE_SECRET_KEY,
};

/**
 * Split schema.sql into individual statements. `--` comments are stripped to end-of-line
 * FIRST (one of them, "-- seconds; same across formats", contains a semicolon that would
 * otherwise split a statement in half), then the result is split on `;`. No string literal
 * in the schema contains `--`, so the naive strip is safe here.
 */
export function schemaStatements(sql: string): string[] {
  return sql
    .split("\n")
    .map((line) => {
      const i = line.indexOf("--");
      return i >= 0 ? line.slice(0, i) : line;
    })
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Apply the full schema to the test D1. Idempotent (CREATE … IF NOT EXISTS). */
export async function applySchema(db: D1Database = testEnv.DB): Promise<void> {
  for (const stmt of schemaStatements(schemaSql)) await db.prepare(stmt).run();
}

/**
 * Seed a minimal but coherent library:
 *   - one presignable S3 backend ("garage-home", with endpoint + secret_ref GARAGE_HOME),
 *   - artist "The Beatles" (index bucket "B") → album "Abbey Road" → track "Come Together",
 *   - one track_file for that track,
 *   - one non-admin user "alice" (password pw-alice, apiKey KEY-ALICE).
 */
export async function seedLibrary(db: D1Database = testEnv.DB): Promise<void> {
  await db.batch([
    db.prepare(
      `INSERT INTO storage_backends (id, name, type, endpoint, region, bucket, role, priority, secret_ref, enabled)
       VALUES ('garage-home','Home','garage','https://s3.example.test','garage','music','primary',100,'GARAGE_HOME',1)`
    ),
    db.prepare(`INSERT INTO artists (id, name) VALUES ('art1','The Beatles')`),
    db.prepare(
      `INSERT INTO albums (id, name, artist_id, artist_name, year, song_count, duration)
       VALUES ('alb1','Abbey Road','art1','The Beatles',1969,1,180)`
    ),
    db.prepare(
      `INSERT INTO tracks (id, title, album_id, album_name, artist_id, artist_name,
                           track_number, duration, suffix, content_type, bit_rate, size)
       VALUES ('trk1','Come Together','alb1','Abbey Road','art1','The Beatles',
               1,180,'flac','audio/flac',900,12345)`
    ),
    db.prepare(
      `INSERT INTO track_files (id, track_id, backend_id, key, format, is_original)
       VALUES ('tf1','trk1','garage-home','Beatles/AbbeyRoad/01.flac','flac',1)`
    ),
    db.prepare(
      `INSERT INTO users (id, username, password, is_admin, api_key)
       VALUES ('u1','alice','pw-alice',0,'KEY-ALICE')`
    ),
  ]);
}

/**
 * Delete every row from every user table (schema is kept). The @cloudflare/vitest-plugin
 * runtime isolates storage per FILE, not per test (unlike the old vitest-pool-workers),
 * so tests must reset to a known baseline themselves. FKs are not enforced (no
 * `PRAGMA foreign_keys = ON` in the schema), so delete order does not matter.
 */
export async function resetDb(db: D1Database = testEnv.DB): Promise<void> {
  const { results } = await db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'"
    )
    .all<{ name: string }>();
  if (results.length === 0) return;
  // D1 (newer Miniflare) enforces foreign keys, so a bare delete of every table hits FK
  // violations on parents still referenced by children. `defer_foreign_keys` within the
  // batch's transaction postpones the checks to commit, by which point all tables are empty.
  await db.batch([
    db.prepare("PRAGMA defer_foreign_keys = TRUE"),
    ...results.map((t) => db.prepare(`DELETE FROM "${t.name}"`)),
  ]);
}

/** Reset to the standard seeded library — call in beforeEach so each test starts clean. */
export async function freshLibrary(db: D1Database = testEnv.DB): Promise<void> {
  await resetDb(db);
  await seedLibrary(db);
}

/** Drive the router with a GET to /rest/<method> and the given query params. */
export async function call(
  method: string,
  query: Record<string, string> = {}
): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  const url = `http://stratum.test/rest/${method}${qs ? `?${qs}` : ""}`;
  return handleApiRequest(new Request(url), testEnv);
}

/** Call expecting JSON (f=json) and return the parsed `subsonic-response` object. */
export async function callJson(
  method: string,
  query: Record<string, string> = {}
): Promise<Record<string, any>> {
  const res = await call(method, { f: "json", ...query });
  const body = (await res.json()) as Record<string, any>;
  return body["subsonic-response"];
}

/** Token-auth params for a stored plaintext password (t = MD5(password + salt)). */
export function tokenAuth(username: string, password: string): Record<string, string> {
  const salt = "napsalt";
  return { u: username, t: Md5.hashStr(password + salt) as string, s: salt };
}

/** Alice's standard token-auth block (the seeded non-admin user). */
export const ALICE = (): Record<string, string> => tokenAuth("alice", "pw-alice");

/** Bootstrap-admin auth block (no DB row; admin via ADMIN_USERNAME/ADMIN_PASSWORD). */
export const ADMIN = (): Record<string, string> => ({ u: "admin", p: ADMIN_PASSWORD });
