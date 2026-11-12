// SPDX-License-Identifier: MIT
// User-management handlers (Subsonic "user management" group):
//   getUser, getUsers, createUser, updateUser, deleteUser, changePassword, getAvatar.
//
// Ported from the old monolith but re-pointed at the NEW schema (schema/schema.sql).
// Key differences from the port source:
//   * the `users` table stores a recoverable PLAINTEXT `password` (schema design, forced by
//     Subsonic token auth) in the `password` column — NOT a `password_hash` column (old drift);
//   * the schema carries no per-capability role columns, so the Subsonic role booleans are
//     synthesized constants (everything granted except podcast/jukebox/share/videoConversion),
//     with adminRole derived from `is_admin` and scrobblingEnabled always true;
//   * admin gating goes through the local `isAdmin` helper (handlers get only params+env):
//     admin == the bootstrap ADMIN_USERNAME (who may not be a DB row) OR a users row with
//     is_admin = 1; admin-only endpoints return error 50 when the authed user is not admin;
//   * every user-supplied value is a bound `?` parameter, never interpolated (#3 discipline).
import type { Env } from "../../shared";
import { respond, respondError, esc } from "../respond";
import { respondDual } from "../serialize";

// ── Admin gate (shared by the radio + scan slices too) ───────────────────────
// Handlers receive only (params, env) — no isAdmin flag — so we re-derive it here from
// the AUTHENTICATED username (params `u`, bound by the router). The bootstrap admin
// (env.ADMIN_USERNAME) is admin even without a DB row; any users row with is_admin = 1
// is admin too. Admin-only endpoints call this and return error 50 when it is false.

/**
 * True if `username` is an admin. The DB row is authoritative: when a users row exists,
 * admin status is EXACTLY that row's is_admin flag (a username collision with the bootstrap
 * name must NOT confer admin). Only when there is NO DB row do we treat the bootstrap
 * ADMIN_USERNAME as admin — that is precisely the case where authentication fell back to the
 * bootstrap ADMIN_PASSWORD (checkAuth only does so for a username with no DB row).
 */
export async function isAdmin(env: Env, username: string): Promise<boolean> {
  if (!username) return false;
  const row = await env.DB.prepare("SELECT is_admin FROM users WHERE username = ?")
    .bind(username)
    .first<{ is_admin: number }>();
  if (row) return !!row.is_admin;              // a DB account is admin ONLY if flagged is_admin
  return username === env.ADMIN_USERNAME;       // no DB row → the pure bootstrap admin (auth used ADMIN_PASSWORD)
}

/** Standard Subsonic "not authorized" error (code 50). */
function notAuthorized(params: URLSearchParams, env: Env): Response {
  return respondError(params, env, 50, "User is not authorized for the given operation");
}

// ── User serialization ───────────────────────────────────────────────────────
// The schema stores only username/email/is_admin for the API's purposes; the rest of the
// Subsonic role set is synthesized. streamRole/settingsRole/download/upload/playlist/coverArt/
// comment are granted to every user; podcast/jukebox/share/videoConversion are not implemented.

/** Subset of the users row the serializer needs. */
interface UserRow {
  username: string;
  email: string | null;
  is_admin: number;
}

/** The synthesized role booleans for a user (adminRole tracks is_admin). */
function roleFields(u: UserRow): Record<string, boolean> {
  const admin = !!u.is_admin;
  return {
    scrobblingEnabled: true,
    adminRole: admin,
    settingsRole: true,
    downloadRole: true,
    uploadRole: true,
    playlistRole: true,
    coverArtRole: true,
    commentRole: true,
    podcastRole: false,
    streamRole: true,
    jukeboxRole: false,
    shareRole: false,
    videoConversionRole: false,
  };
}

function userJson(u: UserRow): Record<string, unknown> {
  return { username: u.username, email: u.email ?? "", ...roleFields(u) };
}

/** Self-closing `<user …/>` carrying username, email and the role booleans. */
function userXml(u: UserRow): string {
  const roles = roleFields(u);
  const roleAttrs = Object.entries(roles)
    .map(([k, v]) => `${k}="${v}"`)
    .join(" ");
  return `<user username="${esc(u.username)}" email="${esc(u.email ?? "")}" ${roleAttrs}/>`;
}

/** Synthesize the bootstrap-admin user (not necessarily a DB row). */
function bootstrapUser(username: string): UserRow {
  return { username, email: null, is_admin: 1 };
}

// ── getUser ──────────────────────────────────────────────────────────────────
// param `username` defaults to the authenticated user. A non-admin may view ONLY
// themselves (error 50 otherwise). 404 (error 70) when the named user doesn't exist —
// except the bootstrap admin, who is always viewable even without a DB row.

export async function handleGetUser(params: URLSearchParams, env: Env): Promise<Response> {
  const authUser = params.get("u") ?? "";
  const username = params.get("username") ?? authUser;

  if (username !== authUser && !(await isAdmin(env, authUser))) {
    return notAuthorized(params, env);
  }

  const row = await env.DB.prepare("SELECT username, email, is_admin FROM users WHERE username = ?")
    .bind(username)
    .first<UserRow>();
  const user =
    row ?? (username.length > 0 && username === env.ADMIN_USERNAME ? bootstrapUser(username) : null);
  if (!user) return respondError(params, env, 70, "User not found");

  return respondDual(params, env, userXml(user), { user: userJson(user) });
}

// ── getUsers (ADMIN ONLY) ────────────────────────────────────────────────────
// Returns every users row. The bootstrap admin is appended when it has no DB row so the
// admin always sees their own account.

export async function handleGetUsers(params: URLSearchParams, env: Env): Promise<Response> {
  const authUser = params.get("u") ?? "";
  if (!(await isAdmin(env, authUser))) return notAuthorized(params, env);

  const rows = await env.DB.prepare(
    "SELECT username, email, is_admin FROM users ORDER BY username COLLATE NOCASE"
  ).all<UserRow>();
  const users = [...rows.results];
  if (
    typeof env.ADMIN_USERNAME === "string" &&
    env.ADMIN_USERNAME.length > 0 &&
    !users.some((u) => u.username === env.ADMIN_USERNAME)
  ) {
    users.unshift(bootstrapUser(env.ADMIN_USERNAME));
  }

  const xml = `<users>${users.map(userXml).join("")}</users>`;
  return respondDual(params, env, xml, { users: { user: users.map(userJson) } });
}

// ── createUser (ADMIN ONLY) ──────────────────────────────────────────────────
// params: username, password, email, optional adminRole. id via crypto.randomUUID();
// password stored as given (PLAINTEXT — schema design). Duplicate username is rejected.
// A random api_key is minted so the user can also authenticate via OpenSubsonic apiKey.

export async function handleCreateUser(params: URLSearchParams, env: Env): Promise<Response> {
  const authUser = params.get("u") ?? "";
  if (!(await isAdmin(env, authUser))) return notAuthorized(params, env);

  const username = params.get("username");
  const password = params.get("password");
  if (!username || !password) {
    return respondError(params, env, 10, "Missing parameter: username and password are required");
  }

  const existing = await env.DB.prepare("SELECT 1 AS x FROM users WHERE username = ?")
    .bind(username)
    .first<{ x: number }>();
  if (existing) return respondError(params, env, 0, `User already exists: ${username}`);

  const id = crypto.randomUUID();
  const apiKey = Array.from(crypto.getRandomValues(new Uint8Array(16)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  const email = params.get("email"); // null when absent — bound as NULL
  const adminRole = params.get("adminRole") === "true" ? 1 : 0;

  await env.DB.prepare(
    "INSERT INTO users (id, username, password, email, is_admin, api_key) VALUES (?, ?, ?, ?, ?, ?)"
  )
    .bind(id, username, password, email, adminRole, apiKey)
    .run();

  return respond(params, env, "");
}

// ── updateUser (ADMIN ONLY) ──────────────────────────────────────────────────
// params: username + optional email/adminRole/password. Only the provided fields are
// updated (every value bound). Empty success.

export async function handleUpdateUser(params: URLSearchParams, env: Env): Promise<Response> {
  const authUser = params.get("u") ?? "";
  if (!(await isAdmin(env, authUser))) return notAuthorized(params, env);

  const username = params.get("username");
  if (!username) return respondError(params, env, 10, "Missing parameter: username");

  const sets: string[] = [];
  const binds: unknown[] = [];
  const email = params.get("email");
  if (email !== null) {
    sets.push("email = ?");
    binds.push(email);
  }
  const password = params.get("password");
  if (password !== null) {
    sets.push("password = ?"); // plaintext (schema design)
    binds.push(password);
  }
  const adminRole = params.get("adminRole");
  if (adminRole !== null) {
    sets.push("is_admin = ?");
    binds.push(adminRole === "true" ? 1 : 0);
  }

  if (sets.length) {
    binds.push(username);
    await env.DB.prepare(`UPDATE users SET ${sets.join(", ")} WHERE username = ?`)
      .bind(...binds)
      .run();
  }
  return respond(params, env, "");
}

// ── deleteUser (ADMIN ONLY) ──────────────────────────────────────────────────
// param username. Guards: the bootstrap admin (env.ADMIN_USERNAME) is never deletable, and
// the last remaining DB admin is not deletable when no bootstrap admin is configured.

export async function handleDeleteUser(params: URLSearchParams, env: Env): Promise<Response> {
  const authUser = params.get("u") ?? "";
  if (!(await isAdmin(env, authUser))) return notAuthorized(params, env);

  const username = params.get("username");
  if (!username) return respondError(params, env, 10, "Missing parameter: username");
  if (username === env.ADMIN_USERNAME) {
    return respondError(params, env, 50, "Cannot delete the bootstrap admin user");
  }

  const target = await env.DB.prepare("SELECT is_admin FROM users WHERE username = ?")
    .bind(username)
    .first<{ is_admin: number }>();
  if (target?.is_admin) {
    const others = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND username != ?"
    )
      .bind(username)
      .first<{ n: number }>();
    const bootstrapConfigured = typeof env.ADMIN_USERNAME === "string" && env.ADMIN_USERNAME.length > 0;
    if ((others?.n ?? 0) === 0 && !bootstrapConfigured) {
      return respondError(params, env, 50, "Cannot delete the last admin user");
    }
  }

  await env.DB.prepare("DELETE FROM users WHERE username = ?").bind(username).run();
  return respond(params, env, "");
}

// ── changePassword ───────────────────────────────────────────────────────────
// params: username + password. Self OR admin (error 50 otherwise). Password stored as given
// (PLAINTEXT — schema design).

export async function handleChangePassword(
  params: URLSearchParams,
  env: Env
): Promise<Response> {
  const authUser = params.get("u") ?? "";
  const username = params.get("username");
  const password = params.get("password");
  if (!username || !password) {
    return respondError(params, env, 10, "Missing parameter: username and password are required");
  }
  if (username !== authUser && !(await isAdmin(env, authUser))) {
    return notAuthorized(params, env);
  }

  await env.DB.prepare("UPDATE users SET password = ? WHERE username = ?")
    .bind(password, username)
    .run();
  return respond(params, env, "");
}

// ── getAvatar ────────────────────────────────────────────────────────────────
// We store no avatars. getAvatar returns binary normally (not a Subsonic envelope), so a
// missing avatar is a plain HTTP 404 Response.

export async function handleGetAvatar(
  _params: URLSearchParams,
  _env: Env
): Promise<Response> {
  return new Response("Not found", { status: 404 });
}
