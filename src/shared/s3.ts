// SPDX-License-Identifier: MIT
//
// Minimal AWS SigV4 for S3-compatible stores (Garage, MinIO, AWS S3, B2), path-style.
// Workers can't use the AWS SDK, so we sign by hand with WebCrypto. Two entry points:
//   presignGetUrl() — a time-limited GET URL the client is 302-redirected to (stream/cover).
//   signedFetch()   — a server-side signed request (listing + range reads for the importer).
// R2 is handled separately via its binding (see backends.ts) — no SigV4 needed there.

export interface S3Config {
  endpoint: string; // e.g. https://s3.example.com (no trailing slash, no bucket)
  region: string; // e.g. "auto" (R2), "us-east-1", or a Garage region name
  bucket: string;
  accessKey: string;
  secretKey: string;
}

const enc = (s: string) => new TextEncoder().encode(s);

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc(msg));
}

async function sha256Hex(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", enc(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// Empty-body payload hash (we only ever GET/LIST).
const EMPTY_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

function amzDates(now = new Date()): { date: string; time: string } {
  const time = now.toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z";
  return { date: time.slice(0, 8), time };
}

// RFC 3986 encoding for the canonical URI. encodeURIComponent leaves !'()* unescaped, but
// SigV4 (and S3/R2 server-side canonicalization) require them percent-encoded, or the signature
// mismatches on keys containing those characters (e.g. an apostrophe) → 403. Encode per segment
// so the '/' path separators are preserved.
function encodeKey(key: string): string {
  return key
    .split("/")
    .map((seg) =>
      encodeURIComponent(seg).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    )
    .join("/");
}

async function signingKey(cfg: S3Config, date: string): Promise<ArrayBuffer> {
  let k: ArrayBuffer | Uint8Array = enc(`AWS4${cfg.secretKey}`);
  k = await hmac(k, date);
  k = await hmac(k, cfg.region);
  k = await hmac(k, "s3");
  k = await hmac(k, "aws4_request");
  return k as ArrayBuffer;
}

/** Presigned GET URL (query-string auth). Default 1h; bump for very long single files. */
export async function presignGetUrl(cfg: S3Config, key: string, expiresIn = 3600): Promise<string> {
  const { date, time } = amzDates();
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const canonicalUri = `/${cfg.bucket}/${encodeKey(key)}`;
  const url = new URL(cfg.endpoint + canonicalUri);

  url.searchParams.set("X-Amz-Algorithm", "AWS4-HMAC-SHA256");
  url.searchParams.set("X-Amz-Credential", `${cfg.accessKey}/${scope}`);
  url.searchParams.set("X-Amz-Date", time);
  url.searchParams.set("X-Amz-Expires", String(expiresIn));
  url.searchParams.set("X-Amz-SignedHeaders", "host");

  const canonicalQS = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = ["GET", canonicalUri, canonicalQS, `host:${url.host}\n`, "host", "UNSIGNED-PAYLOAD"].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", time, scope, await sha256Hex(canonicalRequest)].join("\n");
  const sig = hex(await hmac(await signingKey(cfg, date), stringToSign));
  url.searchParams.set("X-Amz-Signature", sig);
  return url.toString();
}

export interface SignedFetchOpts {
  key?: string; // object key; omit for bucket-level ops (listing)
  query?: Record<string, string>;
  range?: string; // e.g. "bytes=0-262143"
}

/** Server-side SigV4 request (header auth). Used for ListObjectsV2 and range GETs. */
export async function signedFetch(cfg: S3Config, opts: SignedFetchOpts = {}): Promise<Response> {
  const { date, time } = amzDates();
  const scope = `${date}/${cfg.region}/s3/aws4_request`;
  const canonicalUri = `/${cfg.bucket}` + (opts.key ? `/${encodeKey(opts.key)}` : "/");
  const url = new URL(cfg.endpoint + canonicalUri);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

  const headers: Record<string, string> = { host: url.host, "x-amz-date": time, "x-amz-content-sha256": EMPTY_SHA256 };
  if (opts.range) headers["range"] = opts.range;

  const sortedKeys = Object.keys(headers).sort();
  const canonicalHeaders = sortedKeys.map((k) => `${k}:${headers[k]}\n`).join("");
  const signedHeaders = sortedKeys.join(";");
  const canonicalQS = [...url.searchParams.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");

  const canonicalRequest = ["GET", url.pathname, canonicalQS, canonicalHeaders, signedHeaders, EMPTY_SHA256].join("\n");
  const stringToSign = ["AWS4-HMAC-SHA256", time, scope, await sha256Hex(canonicalRequest)].join("\n");
  const sig = hex(await hmac(await signingKey(cfg, date), stringToSign));

  return fetch(url.toString(), {
    headers: {
      ...headers,
      Authorization: `AWS4-HMAC-SHA256 Credential=${cfg.accessKey}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
    },
  });
}

export interface ListedObject {
  key: string;
  size: number;
}

/** One page of ListObjectsV2. Returns objects + the continuation token for the next page. */
export async function listObjectsPage(
  cfg: S3Config,
  opts: { prefix?: string; continuationToken?: string; maxKeys?: number } = {}
): Promise<{ objects: ListedObject[]; nextToken?: string }> {
  const query: Record<string, string> = { "list-type": "2", "max-keys": String(opts.maxKeys ?? 1000) };
  if (opts.prefix) query["prefix"] = opts.prefix;
  if (opts.continuationToken) query["continuation-token"] = opts.continuationToken;

  const res = await signedFetch(cfg, { query });
  const xml = await res.text();
  if (!res.ok) throw new Error(`ListObjectsV2 ${res.status}: ${xml.slice(0, 300)}`);

  const unescape = (s: string) =>
    s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'");
  const keys = [...xml.matchAll(/<Key>([^<]+)<\/Key>/g)].map((m) => unescape(m[1]));
  const sizes = [...xml.matchAll(/<Size>([^<]+)<\/Size>/g)].map((m) => parseInt(m[1], 10));
  const objects = keys.map((key, i) => ({ key, size: sizes[i] ?? 0 }));
  const nextToken = xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1];
  return { objects, nextToken };
}

/** Range GET → ArrayBuffer (importer header reads). */
export async function getRange(cfg: S3Config, key: string, start: number, end: number): Promise<ArrayBuffer | null> {
  const res = await signedFetch(cfg, { key, range: `bytes=${start}-${end}` });
  if (!res.ok && res.status !== 206) return null;
  return res.arrayBuffer();
}
