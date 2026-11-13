// SPDX-License-Identifier: MIT
// Importer tests against a FAKE S3: we stub global fetch so ListObjectsV2 and range GETs
// are served from an in-memory key→bytes map. This exercises the real scan (enumerate →
// import_worklist, with cursor/done meta and changed-size re-pend) and ingest (range-read
// header → parse tags → upsert artists/albums/tracks/track_files via the ID contract)
// without any network.
//
// scan and ingest are GLOBAL across backends (runScan iterates every enabled backend;
// runIngest drains all pending rows), so each test uses its own backend id + keys, and we
// clear import_worklist before each test. The done/cursor `meta` persists, so a backend a
// previous test finished stays skipped — exactly the resume behavior we want.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { applySchema, testEnv } from "./helpers";
import { runScan } from "../src/importer/scan";
import { runIngest } from "../src/importer/ingest";
import { runImportBatch } from "../src/importer/index";
import { HEADER_BYTES } from "../src/importer/parsers";

// ── FLAC fixture builder (STREAMINFO + VORBIS_COMMENT) ───────────────────────

function pushBlock(parts: number[], type: number, data: Uint8Array, last: boolean): void {
  parts.push((last ? 0x80 : 0x00) | (type & 0x7f));
  parts.push((data.length >> 16) & 0xff, (data.length >> 8) & 0xff, data.length & 0xff);
  parts.push(...data);
}

function vorbisComment(vendor: string, entries: string[]): Uint8Array {
  const enc = new TextEncoder();
  const vb = enc.encode(vendor);
  const eb = entries.map((e) => enc.encode(e));
  const out = new Uint8Array(4 + vb.length + 4 + eb.reduce((n, e) => n + 4 + e.length, 0));
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, vb.length, true); p += 4;
  out.set(vb, p); p += vb.length;
  dv.setUint32(p, eb.length, true); p += 4;
  for (const e of eb) { dv.setUint32(p, e.length, true); p += 4; out.set(e, p); p += e.length; }
  return out;
}

/** Minimal FLAC with STREAMINFO (duration) + VORBIS_COMMENT (tags). */
function flacBytes(comments: string[], sampleRate = 44100, totalSamples = 44100 * 200): Uint8Array {
  const parts: number[] = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
  const si = new Uint8Array(34);
  si[10] = (sampleRate >> 12) & 0xff;
  si[11] = (sampleRate >> 4) & 0xff;
  si[12] = ((sampleRate & 0x0f) << 4) | (Math.floor(totalSamples / 2 ** 32) & 0x0f);
  const lo = totalSamples >>> 0;
  si[13] = (lo >>> 24) & 0xff; si[14] = (lo >>> 16) & 0xff; si[15] = (lo >>> 8) & 0xff; si[16] = lo & 0xff;
  pushBlock(parts, 0, si, false);
  pushBlock(parts, 4, vorbisComment("ref", comments), true);
  return new Uint8Array(parts);
}

// ── Fake S3 over global fetch ────────────────────────────────────────────────

type FileMap = Record<string, Uint8Array | null>; // null => object lists but range GET 404s

function listXml(entries: [string, number][], nextToken?: string): string {
  const contents = entries
    .map(([key, size]) => `<Contents><Key>${key}</Key><Size>${size}</Size></Contents>`)
    .join("");
  const next = nextToken ? `<NextContinuationToken>${nextToken}</NextContinuationToken>` : "";
  return `<?xml version="1.0"?><ListBucketResult>${contents}${next}</ListBucketResult>`;
}

/**
 * Install a fake-S3 fetch. `pages` is the sequence of ListObjectsV2 pages (keys + optional
 * next token); range GETs are served from `files` (null => 404). A range GET must be a GET
 * carrying a `bytes=start-end` Range header — the stub returns only that slice with a
 * matching 206 Content-Range/Content-Length, and rejects a missing range with 400, so a
 * regression that dropped or mangled the range is caught (not silently served the whole
 * object). `calls()` counts requests; `ranges()` records each Range header seen.
 */
function installFakeS3(
  files: FileMap,
  pages: { keys: string[]; nextToken?: string }[]
): { calls: () => number; ranges: () => string[] } {
  let calls = 0;
  const ranges: string[] = [];
  const sizeOf = (k: string) => (files[k] ? files[k]!.byteLength : 1234);
  const fake = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    calls++;
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.searchParams.get("list-type") === "2") {
      const token = url.searchParams.get("continuation-token");
      const idx = token ? pages.findIndex((p) => p.nextToken === token) + 1 : 0;
      const page = pages[idx] ?? { keys: [] as string[] };
      return new Response(
        listXml(page.keys.map((k) => [k, sizeOf(k)] as [string, number]), page.nextToken),
        { status: 200 }
      );
    }
    // Range GET: /<bucket>/<encoded key...>
    const segs = url.pathname.split("/").filter(Boolean);
    const key = segs.slice(1).map(decodeURIComponent).join("/");
    const bytes = files[key];
    if (!bytes) return new Response("NoSuchKey", { status: 404 });

    const method = (init?.method ?? "GET").toUpperCase();
    const rangeHeader = new Headers(init?.headers as HeadersInit | undefined).get("range");
    if (method !== "GET" || !rangeHeader) {
      return new Response("Range required", { status: 400 });
    }
    ranges.push(rangeHeader);
    const m = /^bytes=(\d+)-(\d+)$/.exec(rangeHeader);
    const start = m ? parseInt(m[1], 10) : 0;
    const end = Math.min(m ? parseInt(m[2], 10) : bytes.byteLength - 1, bytes.byteLength - 1);
    const slice = bytes.subarray(start, end + 1);
    return new Response(slice, {
      status: 206,
      headers: {
        "Content-Range": `bytes ${start}-${end}/${bytes.byteLength}`,
        "Content-Length": String(slice.byteLength),
      },
    });
  };
  vi.stubGlobal("fetch", vi.fn(fake));
  return { calls: () => calls, ranges: () => ranges };
}

/** Insert a presignable backend (shares the GARAGE_HOME creds already in testEnv). */
async function addBackend(id: string, bucket: string): Promise<void> {
  await testEnv.DB.prepare(
    `INSERT INTO storage_backends (id, name, type, endpoint, region, bucket, role, priority, secret_ref, enabled)
     VALUES (?, ?, 'garage','https://s3.example.test','garage', ?, 'primary', 100, 'GARAGE_HOME', 1)`
  ).bind(id, id, bucket).run();
}

const worklist = (backendId: string) =>
  testEnv.DB.prepare(
    "SELECT key, status FROM import_worklist WHERE backend_id = ? ORDER BY key"
  ).bind(backendId).all<{ key: string; status: string }>();

beforeAll(async () => {
  await applySchema();
});

beforeEach(async () => {
  // Drain the worklist so each test sees only the rows its own scan enqueues. Finished
  // backends stay 'done' via meta, so runScan still skips them (no re-enumeration).
  await testEnv.DB.prepare("DELETE FROM import_worklist").run();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("runScan", () => {
  it("enqueues only audio keys and marks the backend done when a pass completes", async () => {
    await addBackend("b-scan", "scanbucket");
    installFakeS3(
      { "A/B/01.flac": flacBytes(["TITLE=x"]), "A/B/02.mp3": new Uint8Array(8), "A/B/cover.jpg": null },
      [{ keys: ["A/B/01.flac", "A/B/02.mp3", "A/B/cover.jpg"] }]
    );

    const requests = await runScan(testEnv);
    expect(requests).toBe(1); // one backend, one page

    const rows = await worklist("b-scan");
    expect(rows.results.map((r) => r.key)).toEqual(["A/B/01.flac", "A/B/02.mp3"]); // no cover.jpg
    expect(rows.results.every((r) => r.status === "pending")).toBe(true);

    const done = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:done:b-scan'").first();
    expect(done).not.toBeNull();
    const cursor = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:cursor:b-scan'").first();
    expect(cursor).toBeNull(); // cleared on completion
  });

  it("parks a continuation token and resumes on the next tick", async () => {
    await addBackend("b-page", "pagebucket");
    installFakeS3(
      { "P/1.flac": flacBytes(["TITLE=1"]), "P/2.flac": flacBytes(["TITLE=2"]) },
      [
        { keys: ["P/1.flac"], nextToken: "TOKEN2" },
        { keys: ["P/2.flac"] },
      ]
    );

    await runScan(testEnv); // tick 1 → page 1, cursor parked
    let cursor = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:cursor:b-page'").first<{ value: string }>();
    expect(cursor?.value).toBe("TOKEN2");

    await runScan(testEnv); // tick 2 → page 2, cursor cleared + done
    cursor = await testEnv.DB.prepare("SELECT value FROM meta WHERE key = 'scan:cursor:b-page'").first<{ value: string }>();
    expect(cursor).toBeNull();

    const rows = await worklist("b-page");
    expect(rows.results.map((r) => r.key)).toEqual(["P/1.flac", "P/2.flac"]);
  });

  it("re-pends a 'done' row whose size changed, and leaves same-size rows alone", async () => {
    await addBackend("b-size", "sizebucket");
    installFakeS3({ "S/a.flac": flacBytes(["TITLE=a"]), "S/b.flac": flacBytes(["TITLE=b"]) }, [
      { keys: ["S/a.flac", "S/b.flac"] },
    ]);
    await runScan(testEnv);
    // Simulate a completed ingest of both rows.
    await testEnv.DB.prepare("UPDATE import_worklist SET status = 'done' WHERE backend_id = 'b-size'").run();
    vi.unstubAllGlobals();

    // Reopen the backend for a fresh pass (what startScan does) and change a.flac's size.
    await testEnv.DB.prepare("DELETE FROM meta WHERE key = 'scan:done:b-size'").run();
    installFakeS3({ "S/a.flac": new Uint8Array(999), "S/b.flac": flacBytes(["TITLE=b"]) }, [
      { keys: ["S/a.flac", "S/b.flac"] },
    ]);
    await runScan(testEnv);

    const rows = await worklist("b-size");
    const byKey = Object.fromEntries(rows.results.map((r) => [r.key, r.status]));
    expect(byKey["S/a.flac"]).toBe("pending"); // size changed → re-pended
    expect(byKey["S/b.flac"]).toBe("done"); // unchanged → left as-is
  });
});

describe("runIngest", () => {
  it("reads headers, parses tags, and builds the library via the ID contract", async () => {
    await addBackend("b-ingest", "ingestbucket");
    const flac = flacBytes([
      "TITLE=Come Together",
      "ARTIST=The Beatles",
      "ALBUM=Abbey Road",
      "TRACKNUMBER=1",
      "DATE=1969",
    ]);
    const s3 = installFakeS3(
      {
        "The Beatles/Abbey Road/01 Come Together.flac": flac,
        "Pink Floyd/Animals/02 Dogs.mp3": new Uint8Array(32), // unparseable → filename fallback
      },
      [{ keys: ["The Beatles/Abbey Road/01 Come Together.flac", "Pink Floyd/Animals/02 Dogs.mp3"] }]
    );

    await runScan(testEnv);
    const { processed, requests } = await runIngest(testEnv, 10);
    expect(processed).toBe(2);
    expect(requests).toBe(2); // one range GET per file
    // The importer asks for exactly the leading HEADER_BYTES of each object.
    expect(s3.ranges()).toEqual([`bytes=0-${HEADER_BYTES - 1}`, `bytes=0-${HEADER_BYTES - 1}`]);

    // FLAC: tags win.
    const flacTrack = await testEnv.DB.prepare(
      "SELECT title, artist_name, album_name, duration, suffix FROM tracks WHERE title = 'Come Together'"
    ).first<{ title: string; artist_name: string; album_name: string; duration: number; suffix: string }>();
    expect(flacTrack).toMatchObject({
      title: "Come Together",
      artist_name: "The Beatles",
      album_name: "Abbey Road",
      duration: 200, // 44100*200 / 44100
      suffix: "flac",
    });

    // MP3 with no readable tags: filename fallback (Artist/Album/NN Title).
    const mp3Track = await testEnv.DB.prepare(
      "SELECT title, artist_name, album_name, track_number FROM tracks WHERE album_name = 'Animals'"
    ).first<{ title: string; artist_name: string; album_name: string; track_number: number }>();
    expect(mp3Track).toMatchObject({
      title: "Dogs",
      artist_name: "Pink Floyd",
      album_name: "Animals",
      track_number: 2,
    });

    // track_files + album aggregate + worklist all updated.
    const files = await testEnv.DB.prepare(
      "SELECT COUNT(*) AS n FROM track_files WHERE backend_id = 'b-ingest' AND is_original = 1"
    ).first<{ n: number }>();
    expect(files!.n).toBe(2);

    const album = await testEnv.DB.prepare(
      "SELECT song_count, duration FROM albums WHERE name = 'Abbey Road'"
    ).first<{ song_count: number; duration: number }>();
    expect(album).toMatchObject({ song_count: 1, duration: 200 });

    const pending = await worklist("b-ingest");
    expect(pending.results.every((r) => r.status === "done")).toBe(true);
  });

  it("marks a row 'error' (not done) when the range GET fails", async () => {
    await addBackend("b-err", "errbucket");
    installFakeS3({ "E/broken.flac": null }, [{ keys: ["E/broken.flac"] }]); // null => 404 on GET
    await runScan(testEnv);
    const { processed } = await runIngest(testEnv, 10);
    expect(processed).toBe(0);

    const row = await testEnv.DB.prepare(
      "SELECT status, error FROM import_worklist WHERE backend_id = 'b-err' AND key = 'E/broken.flac'"
    ).first<{ status: string; error: string | null }>();
    expect(row?.status).toBe("error");
    expect(row?.error).toBeTruthy();
  });
});

describe("runImportBatch", () => {
  it("scans and ingests in a single tick", async () => {
    await addBackend("b-batch", "batchbucket");
    installFakeS3({ "Solo/Album/1 Song.flac": flacBytes(["TITLE=Solo Song", "ARTIST=Solo"]) }, [
      { keys: ["Solo/Album/1 Song.flac"] },
    ]);

    const result = await runImportBatch(testEnv);
    expect(result.scanRequests).toBeGreaterThanOrEqual(1);
    expect(result.ingested).toBe(1);

    const track = await testEnv.DB.prepare("SELECT title FROM tracks WHERE title = 'Solo Song'").first();
    expect(track).not.toBeNull();
  });
});
