// SPDX-License-Identifier: MIT
// Streaming + cover-art against a seeded D1. The Worker never proxies bytes: it presigns a
// short-lived S3 URL and 302-redirects. We assert the redirect target (host + bucket/key +
// SigV4 signature), the error paths (missing/unknown id), cover-art resolution (album
// presign, artist external URL, none), and graceful failure when a backend lacks creds.

import { describe, it, expect, beforeAll } from "vitest";
import { applySchema, seedLibrary, call, callJson, ALICE, testEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
  await seedLibrary();
  // A second backend with no endpoint/secret_ref (an R2-binding placeholder, not wired in
  // v1) plus a track whose only file lives there — to exercise the graceful-failure path.
  await testEnv.DB.batch([
    testEnv.DB.prepare(
      `INSERT INTO storage_backends (id, name, type, bucket, role, priority, enabled)
       VALUES ('r2-nocreds','R2','r2','media','primary',50,1)`
    ),
    testEnv.DB.prepare(
      `INSERT INTO tracks (id, title, album_id, album_name, artist_id, artist_name, duration, suffix)
       VALUES ('trk9','Orphan','alb1','Abbey Road','art1','The Beatles',120,'flac')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO track_files (id, track_id, backend_id, key, format, is_original)
       VALUES ('tf9','trk9','r2-nocreds','orphan.flac','flac',1)`
    ),
  ]);
});

describe("stream / download (presign + 302)", () => {
  it("stream 302-redirects to a presigned URL for the track's file", async () => {
    const res = await call("stream", { id: "trk1", ...ALICE() });
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("https://s3.example.test/music/Beatles/AbbeyRoad/01.flac");
    expect(loc).toContain("X-Amz-Signature=");
    expect(loc).toContain("X-Amz-Expires=3600");
  });

  it("download 302-redirects to the original file too", async () => {
    const res = await call("download", { id: "trk1", ...ALICE() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toContain("/music/Beatles/AbbeyRoad/01.flac");
  });

  it("errors without an id (error 10)", async () => {
    const r = await callJson("stream", ALICE());
    expect(r.error.code).toBe(10);
  });

  it("errors for an unknown track (error 70)", async () => {
    const r = await callJson("stream", { id: "no-such-track", ...ALICE() });
    expect(r.error.code).toBe(70);
  });

  it("fails gracefully (error 0, not 500) when the backend has no credentials", async () => {
    const r = await callJson("stream", { id: "trk9", ...ALICE() });
    expect(r.status).toBe("failed");
    expect(r.error.code).toBe(0);
  });
});

describe("getCoverArt", () => {
  it("presigns an album cover when the album has cover_backend_id + cover_key", async () => {
    await testEnv.DB.prepare(
      "UPDATE albums SET cover_backend_id = 'garage-home', cover_key = 'covers/abbey.jpg' WHERE id = 'alb1'"
    ).run();
    const res = await call("getCoverArt", { id: "alb1", ...ALICE() });
    expect(res.status).toBe(302);
    const loc = res.headers.get("Location")!;
    expect(loc).toContain("https://s3.example.test/music/covers/abbey.jpg");
    expect(loc).toContain("X-Amz-Signature=");
  });

  it("redirects straight to an artist's external image URL (no presign)", async () => {
    await testEnv.DB.prepare(
      "UPDATE artists SET image_url = 'https://img.example.test/beatles.jpg' WHERE id = 'art1'"
    ).run();
    const res = await call("getCoverArt", { id: "art1", ...ALICE() });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("https://img.example.test/beatles.jpg");
  });

  it("errors when there is no cover art (error 70)", async () => {
    const r = await callJson("getCoverArt", { id: "trk1", ...ALICE() }); // a track id: no cover
    expect(r.error.code).toBe(70);
  });
});
