// SPDX-License-Identifier: MIT
// Admin-gated slices against a seeded D1: internet radio (reads open to any authed user,
// mutations admin-only) and scan status (getScanStatus derives scanning/count from the
// importer's worklist + tracks; startScan is admin-only and clears the per-backend
// completion flags so the next cron tick re-enumerates). Admin = the bootstrap admin.

import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { applySchema, freshLibrary, call, callJson, ALICE, ADMIN, testEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
});
beforeEach(async () => {
  await freshLibrary();
});

describe("internet radio", () => {
  it("reads are open; the list starts empty", async () => {
    const r = await callJson("getInternetRadioStations", ALICE());
    expect(r.internetRadioStations.internetRadioStation ?? []).toHaveLength(0);
  });

  it("refuses a non-admin create (error 50)", async () => {
    const r = await callJson("createInternetRadioStation", {
      streamUrl: "http://stream.test/live",
      name: "Pirate",
      ...ALICE(),
    });
    expect(r.error.code).toBe(50);
  });

  it("requires streamUrl + name (error 10)", async () => {
    const r = await callJson("createInternetRadioStation", { name: "No URL", ...ADMIN() });
    expect(r.error.code).toBe(10);
  });

  it("admin can create, update, and delete; reads reflect each change", async () => {
    await call("createInternetRadioStation", {
      streamUrl: "http://stream.test/jazz",
      name: "Jazz FM",
      homepageUrl: "http://jazz.test",
      ...ADMIN(),
    });

    let list = await callJson("getInternetRadioStations", ALICE());
    expect(list.internetRadioStations.internetRadioStation).toHaveLength(1);
    const station = list.internetRadioStations.internetRadioStation[0];
    expect(station).toMatchObject({
      name: "Jazz FM",
      streamUrl: "http://stream.test/jazz",
      homePageUrl: "http://jazz.test",
    });

    await call("updateInternetRadioStation", { id: station.id, name: "Jazz 24", ...ADMIN() });
    list = await callJson("getInternetRadioStations", ALICE());
    expect(list.internetRadioStations.internetRadioStation[0].name).toBe("Jazz 24");

    await call("deleteInternetRadioStation", { id: station.id, ...ADMIN() });
    list = await callJson("getInternetRadioStations", ALICE());
    expect(list.internetRadioStations.internetRadioStation ?? []).toHaveLength(0);
  });

  it("404s an admin update of a nonexistent station (error 70)", async () => {
    const r = await callJson("updateInternetRadioStation", { id: "no-such-station", name: "x", ...ADMIN() });
    expect(r.error.code).toBe(70);
  });

  it("refuses a non-admin update/delete (error 50)", async () => {
    const upd = await callJson("updateInternetRadioStation", { id: "whatever", name: "x", ...ALICE() });
    expect(upd.error.code).toBe(50);
    const del = await callJson("deleteInternetRadioStation", { id: "whatever", ...ALICE() });
    expect(del.error.code).toBe(50);
  });
});

describe("scan status", () => {
  // "Fully idle" = every enabled backend has a scan:done flag AND no worklist row is pending.
  // The seeded backend has no scan:done until a cron pass completes, so we set it here.
  const markBackendScanned = () =>
    testEnv.DB.prepare(
      "INSERT INTO meta (key, value) VALUES ('scan:done:garage-home','2026-01-01') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    ).run();

  it("reports scanning=false and the track count when fully idle", async () => {
    await markBackendScanned();
    const r = await callJson("getScanStatus", ALICE());
    expect(r.scanStatus.scanning).toBe(false);
    expect(r.scanStatus.count).toBe(1); // the one seeded track
  });

  it("reports scanning=true when an enabled backend has no scan:done flag (scan pending)", async () => {
    // Freshly seeded: garage-home is enabled and has never completed a pass.
    const r = await callJson("getScanStatus", ALICE());
    expect(r.scanStatus.scanning).toBe(true);
  });

  it("reports scanning=true while a worklist row is pending", async () => {
    // Mark the backend scanned so the needsScan branch is FALSE — this isolates the
    // worklist-pending path, so the assertion is attributable solely to the pending row
    // (otherwise a fresh backend's missing scan:done would make scanning=true regardless).
    await markBackendScanned();
    await testEnv.DB.prepare(
      "INSERT INTO import_worklist (backend_id, key, status) VALUES ('garage-home','pending/x.flac','pending')"
    ).run();
    const r = await callJson("getScanStatus", ALICE());
    expect(r.scanStatus.scanning).toBe(true);
  });

  it("startScan is admin-only (error 50 for a non-admin)", async () => {
    const r = await callJson("startScan", ALICE());
    expect(r.error.code).toBe(50);
  });

  it("startScan clears the completion flags AND mid-scan cursors, and returns status", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        "INSERT INTO meta (key, value) VALUES ('scan:done:garage-home','2026-01-01') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ),
      testEnv.DB.prepare(
        "INSERT INTO meta (key, value) VALUES ('scan:cursor:garage-home','tok-abc') ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ),
    ]);
    const r = await callJson("startScan", ADMIN());
    expect(r.scanStatus).toBeDefined();
    const done = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:done:garage-home'").first();
    expect(done).toBeNull(); // cleared → cron re-enumerates next tick
    const cursor = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:cursor:garage-home'").first();
    expect(cursor).toBeNull(); // mid-scan cursor cleared → restart from the top, not resume
  });

  it("startScan makes an immediate getScanStatus report scanning=true", async () => {
    // Backend already fully scanned → idle; startScan must flip it back to scanning.
    await markBackendScanned();
    const idle = await callJson("getScanStatus", ADMIN());
    expect(idle.scanStatus.scanning).toBe(false);

    await callJson("startScan", ADMIN());
    const after = await callJson("getScanStatus", ALICE());
    expect(after.scanStatus.scanning).toBe(true); // scan:done cleared → scan pending immediately
  });
});
