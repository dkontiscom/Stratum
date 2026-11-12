// SPDX-License-Identifier: MIT
// Subsonic / OpenSubsonic authentication.
//
// Passwords are stored as recoverable plaintext (schema.sql explains why: Subsonic
// token auth sends t = MD5(password + salt), so the server must know the original).
// Three mechanisms are supported, tried in this order:
//   (a) OpenSubsonic apiKey  — `apiKey` matched against users.api_key
//   (b) token auth           — `u` + `t` = MD5(password + `s` salt) + `s`
//   (c) legacy password      — `p`, either plaintext or `enc:<hex>`
// A bootstrap admin (ADMIN_USERNAME / ADMIN_PASSWORD) works before any DB user
// exists. Any failure returns ok:false; the router maps that to Subsonic error 40.
import { Md5 } from "ts-md5";
import type { Env } from "../shared";

export interface AuthResult {
  ok: boolean;
  username: string;
  isAdmin: boolean;
}

const FAIL: AuthResult = { ok: false, username: "", isAdmin: false };

/** Subset of the users row auth needs. */
interface AuthUserRow {
  username: string;
  password: string;
  is_admin: number;
}

function md5(str: string): string {
  return Md5.hashStr(str);
}

/** Decode a hex-encoded string (used for the Subsonic `enc:` password form). */
function hexDecode(hex: string): string {
  let str = "";
  for (let i = 0; i < hex.length; i += 2) {
    str += String.fromCharCode(parseInt(hex.substr(i, 2), 16));
  }
  return str;
}

export async function checkAuth(params: URLSearchParams, env: Env): Promise<AuthResult> {
  // (a) OpenSubsonic apiKey auth.
  const apiKey = params.get("apiKey");
  if (apiKey) {
    const user = await env.DB.prepare(
      "SELECT username, is_admin FROM users WHERE api_key = ?"
    )
      .bind(apiKey)
      .first<{ username: string; is_admin: number }>();
    if (user) return { ok: true, username: user.username, isAdmin: !!user.is_admin };
    return FAIL;
  }

  const u = params.get("u");
  if (!u) return FAIL;

  // Look up the stored plaintext password. Fall back to the bootstrap admin secret
  // when the user isn't in the DB yet.
  const user = await env.DB.prepare(
    "SELECT username, password, is_admin FROM users WHERE username = ?"
  )
    .bind(u)
    .first<AuthUserRow>();

  const bootstrapAdmin =
    !user && u === env.ADMIN_USERNAME && typeof env.ADMIN_PASSWORD === "string";
  const storedPass = user?.password ?? (bootstrapAdmin ? env.ADMIN_PASSWORD! : null);
  if (!storedPass) return FAIL;

  const isAdmin = user ? !!user.is_admin : bootstrapAdmin;

  // (b) token auth: t = MD5(password + salt).
  const t = params.get("t");
  const s = params.get("s");
  if (t && s) {
    return { ok: t === md5(storedPass + s), username: u, isAdmin };
  }

  // (c) legacy password: plaintext or enc:<hex>.
  const p = params.get("p");
  if (p) {
    const pass = p.startsWith("enc:") ? hexDecode(p.slice(4)) : p;
    return { ok: pass === storedPass, username: u, isAdmin };
  }

  return FAIL;
}
