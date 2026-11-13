// SPDX-License-Identifier: MIT
// User-management handlers against a seeded D1: getUser (self vs admin visibility),
// getUsers (admin-only, bootstrap admin appended), createUser (admin-only, duplicate
// rejected, apiKey minted), updateUser (adminRole promote), deleteUser (bootstrap +
// last-admin guards), changePassword (self or admin, re-auth proves the new password),
// getAvatar (plain 404). Admin calls use the bootstrap admin; alice is the seeded non-admin.

import { describe, it, expect, beforeAll } from "vitest";
import { applySchema, seedLibrary, call, callJson, ALICE, ADMIN, tokenAuth, testEnv } from "./helpers";
import { handleApiRequest } from "../src/server/router";

beforeAll(async () => {
  await applySchema();
  await seedLibrary();
});

describe("getUser", () => {
  it("lets a user view themselves", async () => {
    const r = await callJson("getUser", { username: "alice", ...ALICE() });
    expect(r.user).toMatchObject({ username: "alice", adminRole: false, streamRole: true });
  });

  it("forbids a non-admin from viewing another user (error 50)", async () => {
    // Seed a second user to look at.
    await testEnv.DB.prepare(
      "INSERT OR IGNORE INTO users (id, username, password) VALUES ('ub','bob','pw-bob')"
    ).run();
    const r = await callJson("getUser", { username: "bob", ...ALICE() });
    expect(r.error.code).toBe(50);
  });

  it("lets an admin view any user, and 404s an unknown one (error 70)", async () => {
    const ok = await callJson("getUser", { username: "alice", ...ADMIN() });
    expect(ok.user.username).toBe("alice");
    const missing = await callJson("getUser", { username: "ghost", ...ADMIN() });
    expect(missing.error.code).toBe(70);
  });
});

describe("getUsers (admin only)", () => {
  it("rejects a non-admin (error 50)", async () => {
    const r = await callJson("getUsers", ALICE());
    expect(r.error.code).toBe(50);
  });

  it("lists DB users and appends the bootstrap admin", async () => {
    const r = await callJson("getUsers", ADMIN());
    const names = r.users.user.map((u: { username: string }) => u.username);
    expect(names).toContain("alice");
    expect(names).toContain("admin"); // bootstrap admin with no DB row
  });
});

describe("createUser / updateUser / changePassword", () => {
  it("creates a user (admin only) that can then authenticate", async () => {
    const r = await callJson("createUser", { username: "carol", password: "pw-carol", email: "c@x", ...ADMIN() });
    expect(r.status).toBe("ok");
    // The new user can authenticate (token auth over the stored plaintext password).
    const ping = await callJson("ping", tokenAuth("carol", "pw-carol"));
    expect(ping.status).toBe("ok");
    // An api_key was minted.
    const row = await testEnv.DB.prepare("SELECT api_key FROM users WHERE username = 'carol'")
      .first<{ api_key: string | null }>();
    expect(row?.api_key).toMatch(/^[0-9a-f]{32}$/);
  });

  it("rejects a non-admin creating a user (error 50)", async () => {
    const r = await callJson("createUser", { username: "nope", password: "x", ...ALICE() });
    expect(r.error.code).toBe(50);
  });

  it("rejects a duplicate username (error 0)", async () => {
    const r = await callJson("createUser", { username: "alice", password: "x", ...ADMIN() });
    expect(r.error.code).toBe(0);
  });

  it("promotes a user to admin via updateUser adminRole", async () => {
    await callJson("createUser", { username: "dan", password: "pw-dan", ...ADMIN() });
    await call("updateUser", { username: "dan", adminRole: "true", ...ADMIN() });
    const r = await callJson("getUser", { username: "dan", ...ADMIN() });
    expect(r.user.adminRole).toBe(true);
    // And dan can now exercise an admin-only endpoint.
    const list = await callJson("getUsers", tokenAuth("dan", "pw-dan"));
    expect(list.users.user).toBeDefined();
  });

  it("lets a user change their own password; the new password authenticates", async () => {
    await callJson("createUser", { username: "erin", password: "old-pw", ...ADMIN() });
    const r = await callJson("changePassword", { username: "erin", password: "new-pw", ...tokenAuth("erin", "old-pw") });
    expect(r.status).toBe("ok");
    expect((await callJson("ping", tokenAuth("erin", "new-pw"))).status).toBe("ok");
    expect((await callJson("ping", tokenAuth("erin", "old-pw"))).status).toBe("failed");
  });

  it("forbids a non-admin changing another user's password (error 50)", async () => {
    // alice (seeded non-admin) may not change anyone else's password; the 50 is returned
    // before any lookup of the target, so the target need not exist.
    const r = await callJson("changePassword", { username: "someone-else", password: "hijack", ...ALICE() });
    expect(r.error.code).toBe(50);
  });
});

describe("updateUser last-admin guard", () => {
  it("allows demoting the last DB admin when a bootstrap admin is configured", async () => {
    // Only DB admin; bootstrap "admin" IS configured in testEnv, so the server stays administrable.
    await testEnv.DB.prepare(
      "INSERT INTO users (id, username, password, is_admin) VALUES ('ua','solo','pw',1)"
    ).run();
    const r = await call("updateUser", { username: "solo", adminRole: "false", ...ADMIN() });
    expect(r.status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT is_admin FROM users WHERE username = 'solo'")
      .first<{ is_admin: number }>();
    expect(row?.is_admin).toBe(0);
  });

  it("allows demoting an admin when another admin exists", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare("INSERT INTO users (id, username, password, is_admin) VALUES ('ua1','adm1','pw',1)"),
      testEnv.DB.prepare("INSERT INTO users (id, username, password, is_admin) VALUES ('ua2','adm2','pw',1)"),
    ]);
    const r = await call("updateUser", { username: "adm1", adminRole: "false", ...ADMIN() });
    expect(r.status).toBe(200);
    const row = await testEnv.DB.prepare("SELECT is_admin FROM users WHERE username = 'adm1'")
      .first<{ is_admin: number }>();
    expect(row?.is_admin).toBe(0);
  });

  it("refuses to demote the last admin when NO bootstrap admin is configured (error 50)", async () => {
    const noBootstrap = { ...testEnv, ADMIN_USERNAME: "" };
    // testEnv and noBootstrap share the same DB binding, so this row is visible to both.
    await testEnv.DB.prepare(
      "INSERT INTO users (id, username, password, is_admin) VALUES ('ua','solo','pw',1)"
    ).run();
    // Drive the handler directly against the no-bootstrap env (call/callJson capture testEnv).
    // solo authenticates via token auth over its DB password; isAdmin derives from the DB row.
    const qs = new URLSearchParams({
      username: "solo",
      adminRole: "false",
      ...tokenAuth("solo", "pw"),
      f: "json",
    }).toString();
    const res = await handleApiRequest(new Request("http://x/rest/updateUser?" + qs), noBootstrap);
    const body = (await res.json() as Record<string, any>)["subsonic-response"];
    expect(body.error.code).toBe(50);
    const row = await testEnv.DB.prepare("SELECT is_admin FROM users WHERE username = 'solo'")
      .first<{ is_admin: number }>();
    expect(row?.is_admin).toBe(1); // demotion was blocked
  });
});

describe("deleteUser guards", () => {
  it("refuses to delete the bootstrap admin (error 50)", async () => {
    const r = await callJson("deleteUser", { username: "admin", ...ADMIN() });
    expect(r.error.code).toBe(50);
  });

  it("deletes an ordinary user", async () => {
    await callJson("createUser", { username: "frank", password: "x", ...ADMIN() });
    const r = await callJson("deleteUser", { username: "frank", ...ADMIN() });
    expect(r.status).toBe("ok");
    const row = await testEnv.DB.prepare("SELECT 1 AS x FROM users WHERE username = 'frank'").first();
    expect(row).toBeNull();
  });
});

describe("getAvatar", () => {
  it("returns a plain 404 (we store no avatars)", async () => {
    const res = await call("getAvatar", { username: "alice", ...ALICE() });
    expect(res.status).toBe(404);
  });
});
