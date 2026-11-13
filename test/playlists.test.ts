// SPDX-License-Identifier: MIT
// Playlist lifecycle against a seeded D1: create → read → update (add/remove, rename,
// visibility) → delete, plus the owner-only authorization (error 50) and private-playlist
// visibility rules (a non-owner gets error 70, which also hides existence).

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, freshLibrary, call, callJson, ALICE, ADMIN_PASSWORD, testEnv } from "./helpers";

const ADMIN = () => ({ u: "admin", p: ADMIN_PASSWORD });

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await freshLibrary();
  // A second track so add/remove has something to move around.
  await testEnv.DB.prepare(
    `INSERT INTO tracks (id, title, album_id, album_name, artist_id, artist_name,
                         track_number, duration, suffix)
     VALUES ('trk2','Something','alb1','Abbey Road','art1','The Beatles',2,150,'flac')`
  ).run();
});

describe("createPlaylist + getPlaylist", () => {
  it("creates a playlist owned by the caller with its songs", async () => {
    const r = await callJson("createPlaylist", { name: "Faves", songId: "trk1", ...ALICE() });
    expect(r.playlist).toMatchObject({ name: "Faves", owner: "alice", public: false, songCount: 1 });
    expect(r.playlist.entry[0].id).toBe("trk1");

    const got = await callJson("getPlaylist", { id: r.playlist.id, ...ALICE() });
    expect(got.playlist.id).toBe(r.playlist.id);
    expect(got.playlist.entry.map((e: { id: string }) => e.id)).toEqual(["trk1"]);
  });

  it("drops bogus song ids and counts only real tracks", async () => {
    const r = await callJson("createPlaylist", { name: "Mixed", songId: "nope", ...ALICE() });
    expect(r.playlist.songCount).toBe(0);
  });
});

describe("getPlaylists visibility", () => {
  it("lists the owner's playlists but hides private ones from others", async () => {
    const r = await callJson("createPlaylist", { name: "Private Mix", songId: "trk1", ...ALICE() });
    const id = r.playlist.id;

    const mine = await callJson("getPlaylists", ALICE());
    expect(mine.playlists.playlist.map((p: { id: string }) => p.id)).toContain(id);

    // A different user cannot see or fetch a private playlist.
    const theirs = await callJson("getPlaylists", ADMIN());
    expect((theirs.playlists.playlist ?? []).map((p: { id: string }) => p.id)).not.toContain(id);

    const fetch = await callJson("getPlaylist", { id, ...ADMIN() });
    expect(fetch.error.code).toBe(70); // hidden => "not found"
  });
});

describe("updatePlaylist", () => {
  it("adds, removes, renames, and flips visibility", async () => {
    const created = await callJson("createPlaylist", { name: "Working", songId: "trk1", ...ALICE() });
    const id = created.playlist.id;

    // Append trk2.
    await call("updatePlaylist", { playlistId: id, songIdToAdd: "trk2", ...ALICE() });
    let got = await callJson("getPlaylist", { id, ...ALICE() });
    expect(got.playlist.entry.map((e: { id: string }) => e.id)).toEqual(["trk1", "trk2"]);

    // Remove position 0 (trk1), rename, and make public.
    await call("updatePlaylist", {
      playlistId: id,
      songIndexToRemove: "0",
      name: "Renamed",
      public: "true",
      ...ALICE(),
    });
    got = await callJson("getPlaylist", { id, ...ALICE() });
    expect(got.playlist.name).toBe("Renamed");
    expect(got.playlist.public).toBe(true);
    expect(got.playlist.entry.map((e: { id: string }) => e.id)).toEqual(["trk2"]);

    // Now public → a different user can fetch it.
    const asAdmin = await callJson("getPlaylist", { id, ...ADMIN() });
    expect(asAdmin.playlist.id).toBe(id);
  });

  it("refuses a non-owner (error 50)", async () => {
    const created = await callJson("createPlaylist", { name: "Guarded", songId: "trk1", ...ALICE() });
    const r = await callJson("updatePlaylist", { playlistId: created.playlist.id, name: "Hijacked", ...ADMIN() });
    expect(r.error.code).toBe(50);
  });
});

describe("deletePlaylist", () => {
  it("deletes an owned playlist", async () => {
    const created = await callJson("createPlaylist", { name: "Temp", ...ALICE() });
    const id = created.playlist.id;
    const del = await callJson("deletePlaylist", { id, ...ALICE() });
    expect(del.status).toBe("ok");
    const got = await callJson("getPlaylist", { id, ...ALICE() });
    expect(got.error.code).toBe(70);
  });

  it("refuses a non-owner (error 50)", async () => {
    const created = await callJson("createPlaylist", { name: "Keep", ...ALICE() });
    const r = await callJson("deletePlaylist", { id: created.playlist.id, ...ADMIN() });
    expect(r.error.code).toBe(50);
  });

  it("accepts the id passed as `playlistId` (lenient-client fallback)", async () => {
    const created = await callJson("createPlaylist", { name: "Temp", ...ALICE() });
    const id = created.playlist.id;
    const del = await callJson("deletePlaylist", { playlistId: id, ...ALICE() });
    expect(del.status).toBe("ok");
    const got = await callJson("getPlaylist", { id, ...ALICE() });
    expect(got.error.code).toBe(70);
  });
});
