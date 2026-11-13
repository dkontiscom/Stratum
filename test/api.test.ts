// SPDX-License-Identifier: MIT
// Integration tests against a seeded D1 (the vitest-pool-workers Miniflare D1). We apply
// the real schema, seed a tiny library + one user, and drive the router end-to-end to
// cover the auth mechanisms, the response-format dispatch, and a browsing read.

import { describe, it, expect, beforeAll } from "vitest";
import { applySchema, seedLibrary, call, callJson, tokenAuth, ALICE, ADMIN_PASSWORD, testEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
  await seedLibrary();
});

describe("authentication", () => {
  it("rejects a request with no credentials (error 10, missing param)", async () => {
    const r = await callJson("ping");
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(10);
  });

  it("rejects a username with no password or token (error 10, missing param)", async () => {
    const r = await callJson("ping", { u: "alice" });
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(10);
  });

  it("rejects a wrong password", async () => {
    const r = await callJson("ping", { u: "alice", p: "wrong" });
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(40);
  });

  it("accepts token auth (t = MD5(password + salt))", async () => {
    const r = await callJson("ping", ALICE());
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
    const r = await callJson("ping", ALICE());
    expect(r.status).toBe("ok");
    expect(r.openSubsonic).toBe(true);
    expect(typeof r.version).toBe("string");
    expect(r.serverVersion).toBe("0.1.0");
  });

  it("defaults to XML and escapes correctly", async () => {
    const res = await call("ping", ALICE());
    expect(res.headers.get("content-type")).toContain("xml");
    const text = await res.text();
    expect(text).toContain('status="ok"');
    expect(text).toContain("<subsonic-response");
  });

  it("getLicense reports a valid license", async () => {
    const r = await callJson("getLicense", ALICE());
    expect(r.license.valid).toBe(true);
  });

  it("getOpenSubsonicExtensions advertises formPost + apiKeyAuthentication", async () => {
    const r = await callJson("getOpenSubsonicExtensions", ALICE());
    const names = r.openSubsonicExtensions.map((e: { name: string }) => e.name);
    expect(names).toContain("formPost");
    expect(names).toContain("apiKeyAuthentication");
  });

  it("getOpenSubsonicExtensions honours f=xml (default)", async () => {
    const res = await call("getOpenSubsonicExtensions", ALICE());
    expect(res.headers.get("content-type")).toContain("xml");
    const text = await res.text();
    expect(text).toContain('name="formPost"');
    expect(text).toContain("<openSubsonicExtensions");
  });

  it("returns error 0 for an unknown method (authed)", async () => {
    const r = await callJson("noSuchMethod", ALICE());
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(0);
  });
});

describe("browsing (seeded library)", () => {
  it("getMusicFolders returns the single logical folder", async () => {
    const r = await callJson("getMusicFolders", ALICE());
    expect(r.musicFolders.musicFolder[0]).toMatchObject({ id: "1", name: "Music" });
  });

  it("getArtists buckets 'The Beatles' under 'B' with a real album count", async () => {
    const r = await callJson("getArtists", ALICE());
    const bucketB = r.artists.index.find((i: { name: string }) => i.name === "B");
    expect(bucketB).toBeDefined();
    const beatles = bucketB.artist.find((a: { name: string }) => a.name === "The Beatles");
    expect(beatles).toMatchObject({ id: "art1", albumCount: 1, coverArt: "art1" });
  });

  it("getIndexes emits the stored library:lastModified (not Date.now())", async () => {
    // Self-contained: seed a fixed last-modified; the handler must echo it verbatim, proving
    // the value is read from meta rather than regenerated per call. (Rolled back after this it.)
    await testEnv.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('library:lastModified', '1730000000000')"
    ).run();
    const r = await callJson("getIndexes", ALICE());
    expect(r.indexes.lastModified).toBe(1730000000000);
  });

  it("getMusicDirectory lists an artist's albums with songCount", async () => {
    const r = await callJson("getMusicDirectory", { id: "art1", ...ALICE() });
    expect(r.directory.child[0]).toMatchObject({
      id: "alb1",
      isDir: true,
      songCount: 1,
    });
  });

  it("getArtist lists the artist's albums", async () => {
    const r = await callJson("getArtist", { id: "art1", ...ALICE() });
    expect(r.artist.album[0]).toMatchObject({ id: "alb1", name: "Abbey Road" });
  });

  it("getSong returns the seeded track with its original-file properties", async () => {
    const r = await callJson("getSong", { id: "trk1", ...ALICE() });
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
