// SPDX-License-Identifier: MIT
// Integration tests against a seeded D1 (the vitest-pool-workers Miniflare D1). We apply
// the real schema, seed a tiny library + one user, and drive the router end-to-end to
// cover the auth mechanisms, the response-format dispatch, and a browsing read.

import { describe, it, expect, beforeAll } from "vitest";
import { env } from "cloudflare:test";
import { Md5 } from "ts-md5";
// Vite imports the schema file as a raw string so there is no fixture to ship and no
// Node fs dependency inside the worker runtime.
import schemaSql from "../schema/schema.sql?raw";
import { handleApiRequest } from "../src/server/router";
import type { Env } from "../src/shared";

// Bootstrap admin password is a secret (not in wrangler vars), so inject it for the env.
const ADMIN_PASSWORD = "s3cret-admin";
const testEnv = { ...(env as unknown as Env), ADMIN_PASSWORD };

/**
 * Split schema.sql into individual statements. We strip `--` comments to end-of-line
 * FIRST (one of them, "-- seconds; same across formats", contains a semicolon that would
 * otherwise split a statement in half), then split on `;`. No string literal in the
 * schema contains `--`, so the naive strip is safe here.
 */
function schemaStatements(sql: string): string[] {
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

/** Drive the router with a GET to /rest/<method> and the given query params. */
async function call(method: string, query: Record<string, string> = {}): Promise<Response> {
  const qs = new URLSearchParams(query).toString();
  const url = `http://stratum.test/rest/${method}${qs ? `?${qs}` : ""}`;
  return handleApiRequest(new Request(url), testEnv);
}

/** Call expecting JSON (f=json) and return the parsed `subsonic-response` object. */
async function callJson(
  method: string,
  query: Record<string, string> = {}
): Promise<Record<string, any>> {
  const res = await call(method, { f: "json", ...query });
  const body = (await res.json()) as Record<string, any>;
  return body["subsonic-response"];
}

/** Token-auth params for a stored plaintext password. */
function tokenAuth(username: string, password: string): Record<string, string> {
  const salt = "napsalt";
  return { u: username, t: Md5.hashStr(password + salt) as string, s: salt };
}

beforeAll(async () => {
  for (const stmt of schemaStatements(schemaSql)) {
    await testEnv.DB.prepare(stmt).run();
  }
  // Seed: one backend, one artist ("The Beatles" → index bucket "B"), album, track, file.
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO storage_backends (id, name, type, bucket, role) VALUES ('garage-home','Home','garage','music','primary')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO artists (id, name) VALUES ('art1','The Beatles')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO albums (id, name, artist_id, artist_name, year, song_count, duration)
       VALUES ('alb1','Abbey Road','art1','The Beatles',1969,1,180)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO tracks (id, title, album_id, album_name, artist_id, artist_name,
                           track_number, duration, suffix, content_type, bit_rate, size)
       VALUES ('trk1','Come Together','alb1','Abbey Road','art1','The Beatles',
               1,180,'flac','audio/flac',900,12345)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO track_files (id, track_id, backend_id, key, format, is_original)
       VALUES ('tf1','trk1','garage-home','Beatles/AbbeyRoad/01.flac','flac',1)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO users (id, username, password, is_admin, api_key)
       VALUES ('u1','alice','pw-alice',0,'KEY-ALICE')`
    ),
  ]);
});

describe("authentication", () => {
  it("rejects a request with no credentials (error 40)", async () => {
    const r = await callJson("ping");
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(40);
  });

  it("rejects a wrong password", async () => {
    const r = await callJson("ping", { u: "alice", p: "wrong" });
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(40);
  });

  it("accepts token auth (t = MD5(password + salt))", async () => {
    const r = await callJson("ping", tokenAuth("alice", "pw-alice"));
    expect(r.status).toBe("ok");
  });

  it("accepts legacy plaintext password auth", async () => {
    const r = await callJson("ping", { u: "alice", p: "pw-alice" });
    expect(r.status).toBe("ok");
  });

  it("accepts enc:<hex> password auth", async () => {
    const hex = [..."pw-alice"].map((c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
    const r = await callJson("ping", { u: "alice", p: `enc:${hex}` });
    expect(r.status).toBe("ok");
  });

  it("accepts OpenSubsonic apiKey auth", async () => {
    const r = await callJson("ping", { apiKey: "KEY-ALICE" });
    expect(r.status).toBe("ok");
  });

  it("rejects an unknown apiKey", async () => {
    const r = await callJson("ping", { apiKey: "KEY-NOPE" });
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(40);
  });

  it("accepts the bootstrap admin before any DB user exists", async () => {
    const r = await callJson("ping", { u: "admin", p: ADMIN_PASSWORD });
    expect(r.status).toBe("ok");
  });
});

describe("response format + handshake", () => {
  it("returns a well-formed JSON envelope", async () => {
    const r = await callJson("ping", tokenAuth("alice", "pw-alice"));
    expect(r.status).toBe("ok");
    expect(r.openSubsonic).toBe(true);
    expect(typeof r.version).toBe("string");
    expect(r.serverVersion).toBe("0.1.0");
  });

  it("defaults to XML and escapes correctly", async () => {
    const res = await call("ping", tokenAuth("alice", "pw-alice"));
    expect(res.headers.get("content-type")).toContain("xml");
    const text = await res.text();
    expect(text).toContain('status="ok"');
    expect(text).toContain("<subsonic-response");
  });

  it("getLicense reports a valid license", async () => {
    const r = await callJson("getLicense", tokenAuth("alice", "pw-alice"));
    expect(r.license.valid).toBe(true);
  });

  it("getOpenSubsonicExtensions advertises formPost + apiKeyAuthentication", async () => {
    const r = await callJson("getOpenSubsonicExtensions", tokenAuth("alice", "pw-alice"));
    const names = r.openSubsonicExtensions.map((e: { name: string }) => e.name);
    expect(names).toContain("formPost");
    expect(names).toContain("apiKeyAuthentication");
  });

  it("returns error 0 for an unknown method (authed)", async () => {
    const r = await callJson("noSuchMethod", tokenAuth("alice", "pw-alice"));
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(0);
  });
});

describe("browsing (seeded library)", () => {
  it("getMusicFolders returns the single logical folder", async () => {
    const r = await callJson("getMusicFolders", tokenAuth("alice", "pw-alice"));
    expect(r.musicFolders.musicFolder[0]).toMatchObject({ id: "1", name: "Music" });
  });

  it("getArtists buckets 'The Beatles' under 'B' with a real album count", async () => {
    const r = await callJson("getArtists", tokenAuth("alice", "pw-alice"));
    const bucketB = r.artists.index.find((i: { name: string }) => i.name === "B");
    expect(bucketB).toBeDefined();
    const beatles = bucketB.artist.find((a: { name: string }) => a.name === "The Beatles");
    expect(beatles).toMatchObject({ id: "art1", albumCount: 1, coverArt: "art1" });
  });

  it("getArtist lists the artist's albums", async () => {
    const r = await callJson("getArtist", { id: "art1", ...tokenAuth("alice", "pw-alice") });
    expect(r.artist.album[0]).toMatchObject({ id: "alb1", name: "Abbey Road" });
  });

  it("getSong returns the seeded track with its original-file properties", async () => {
    const r = await callJson("getSong", { id: "trk1", ...tokenAuth("alice", "pw-alice") });
    expect(r.song).toMatchObject({
      id: "trk1",
      title: "Come Together",
      album: "Abbey Road",
      artist: "The Beatles",
      suffix: "flac",
      duration: 180,
    });
  });
});
