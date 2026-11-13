// SPDX-License-Identifier: MIT
// Annotation + play-logging round-trips against a seeded D1: star/unstar surfaced via
// getStarred2, setRating stored per (user,item), and the scrobble vs now-playing-ping
// split (submission=true logs history + bumps play_count; submission=false touches only
// now_playing). Each test performs its own writes so it is independent of storage reset.

import { describe, it, expect, beforeAll } from "vitest";
import { applySchema, seedLibrary, call, callJson, ALICE, testEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
  await seedLibrary();
});

describe("star / unstar", () => {
  it("star surfaces track + album + artist in getStarred2, unstar removes them", async () => {
    await call("star", { id: "trk1", albumId: "alb1", artistId: "art1", ...ALICE() });

    let r = await callJson("getStarred2", ALICE());
    expect(r.starred2.song.map((s: { id: string }) => s.id)).toContain("trk1");
    expect(r.starred2.album.map((a: { id: string }) => a.id)).toContain("alb1");
    expect(r.starred2.artist.map((a: { id: string }) => a.id)).toContain("art1");

    await call("unstar", { id: "trk1", albumId: "alb1", artistId: "art1", ...ALICE() });

    r = await callJson("getStarred2", ALICE());
    expect(r.starred2.song ?? []).toHaveLength(0);
    expect(r.starred2.album ?? []).toHaveLength(0);
    expect(r.starred2.artist ?? []).toHaveLength(0);
  });

  it("getStarred (v1 wrapper) serves the same data under a different key", async () => {
    await call("star", { id: "trk1", ...ALICE() });
    const r = await callJson("getStarred", ALICE());
    expect(r.starred.song.map((s: { id: string }) => s.id)).toContain("trk1");
    await call("unstar", { id: "trk1", ...ALICE() });
  });
});

describe("setRating", () => {
  it("stores a rating on the correct item type, and rating 0 clears it", async () => {
    await call("setRating", { id: "alb1", rating: "4", ...ALICE() });
    let row = await testEnv.DB.prepare(
      "SELECT item_type, rating FROM annotations WHERE user = 'alice' AND item_id = 'alb1'"
    ).first<{ item_type: string; rating: number | null }>();
    expect(row).toMatchObject({ item_type: "album", rating: 4 });

    await call("setRating", { id: "alb1", rating: "0", ...ALICE() });
    row = await testEnv.DB.prepare(
      "SELECT item_type, rating FROM annotations WHERE user = 'alice' AND item_id = 'alb1'"
    ).first<{ item_type: string; rating: number | null }>();
    expect(row?.rating).toBeNull();
  });

  it("clamps an out-of-range rating to 5", async () => {
    await call("setRating", { id: "trk1", rating: "9", ...ALICE() });
    const row = await testEnv.DB.prepare(
      "SELECT rating FROM annotations WHERE user = 'alice' AND item_type = 'track' AND item_id = 'trk1'"
    ).first<{ rating: number }>();
    expect(row?.rating).toBe(5);
  });

  it("errors without an id (error 10)", async () => {
    const r = await callJson("setRating", { rating: "3", ...ALICE() });
    expect(r.error.code).toBe(10);
  });
});

describe("scrobble vs now-playing ping", () => {
  async function playCount(id: string): Promise<number> {
    const row = await testEnv.DB.prepare("SELECT play_count FROM tracks WHERE id = ?")
      .bind(id)
      .first<{ play_count: number }>();
    return row?.play_count ?? -1;
  }

  it("submission=true bumps play_count, logs history, and does NOT set now_playing", async () => {
    const before = await playCount("trk1");
    await call("scrobble", { id: "trk1", submission: "true", c: "testclient", ...ALICE() });
    expect(await playCount("trk1")).toBe(before + 1);

    const hist = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM play_history WHERE user = 'alice' AND track_id = 'trk1'"
    ).first<{ n: number }>();
    expect(hist!.n).toBeGreaterThanOrEqual(1);

    // A completed play is not "currently playing".
    const np = await testEnv.DB.prepare("SELECT COUNT(*) AS n FROM now_playing WHERE user = 'alice'")
      .first<{ n: number }>();
    expect(np!.n).toBe(0);
  });

  it("submission=false sets now_playing without bumping play_count", async () => {
    const before = await playCount("trk1");
    await call("scrobble", { id: "trk1", submission: "false", c: "pinger", ...ALICE() });
    expect(await playCount("trk1")).toBe(before); // no increment

    const np = await testEnv.DB.prepare(
      "SELECT track_id, player FROM now_playing WHERE user = 'alice'"
    ).first<{ track_id: string; player: string }>();
    expect(np).toMatchObject({ track_id: "trk1", player: "pinger" });

    // getNowPlaying reflects it (within the freshness window), attributed to the user.
    const r = await callJson("getNowPlaying", ALICE());
    expect(r.nowPlaying.entry[0]).toMatchObject({ id: "trk1", username: "alice" });
  });

  it("ignores an unknown track id (FK-safe, no history row)", async () => {
    const r = await callJson("scrobble", { id: "does-not-exist", submission: "true", ...ALICE() });
    expect(r.status).toBe("ok"); // empty success, no 500
    const hist = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM play_history WHERE track_id = 'does-not-exist'"
    ).first<{ n: number }>();
    expect(hist!.n).toBe(0);
  });
});
