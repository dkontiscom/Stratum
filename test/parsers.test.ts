// SPDX-License-Identifier: MIT
// Tests for the audio tag parsers (src/importer/parsers). We hand-build minimal valid
// FLAC and MP3 headers so the tests have no binary fixtures to ship. Each parser is a
// pure function (bytes in, tags out) and must degrade gracefully on garbage.

import { describe, it, expect } from "vitest";
import { parseFlac } from "../src/importer/parsers/flac";
import { parseMp3 } from "../src/importer/parsers/mp3";
import { parseTags, isParsable } from "../src/importer/parsers";

// ── FLAC builders ─────────────────────────────────────────────────────────────

/** Build a STREAMINFO (type 0) 34-byte data block for the given rate + total samples. */
function streamInfo(sampleRate: number, totalSamples: number): Uint8Array {
  const b = new Uint8Array(34);
  // bytes 10..12: 20-bit sample rate; byte 12 low nibble + 13..16: 36-bit total samples
  b[10] = (sampleRate >> 12) & 0xff;
  b[11] = (sampleRate >> 4) & 0xff;
  const hi4 = Math.floor(totalSamples / 2 ** 32) & 0x0f; // top 4 bits of 36-bit count
  b[12] = ((sampleRate & 0x0f) << 4) | hi4;
  const lo = totalSamples >>> 0;
  b[13] = (lo >>> 24) & 0xff;
  b[14] = (lo >>> 16) & 0xff;
  b[15] = (lo >>> 8) & 0xff;
  b[16] = lo & 0xff;
  return b;
}

/** Build a VORBIS_COMMENT (type 4) data block from a vendor string + key=value entries. */
function vorbisComment(vendor: string, entries: string[]): Uint8Array {
  const enc = new TextEncoder();
  const vendorBytes = enc.encode(vendor);
  const entryBytes = entries.map((e) => enc.encode(e));
  const total =
    4 + vendorBytes.length + 4 + entryBytes.reduce((n, e) => n + 4 + e.length, 0);
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  let p = 0;
  dv.setUint32(p, vendorBytes.length, true);
  p += 4;
  out.set(vendorBytes, p);
  p += vendorBytes.length;
  dv.setUint32(p, entryBytes.length, true);
  p += 4;
  for (const e of entryBytes) {
    dv.setUint32(p, e.length, true);
    p += 4;
    out.set(e, p);
    p += e.length;
  }
  return out;
}

/** Assemble a FLAC file: "fLaC" + a chain of metadata blocks (last one flagged). */
function flacFile(blocks: { type: number; data: Uint8Array }[]): Uint8Array {
  const parts: number[] = [0x66, 0x4c, 0x61, 0x43]; // "fLaC"
  blocks.forEach((blk, i) => {
    const last = i === blocks.length - 1 ? 0x80 : 0x00;
    parts.push(last | (blk.type & 0x7f));
    const len = blk.data.length;
    parts.push((len >> 16) & 0xff, (len >> 8) & 0xff, len & 0xff);
    parts.push(...blk.data);
  });
  return new Uint8Array(parts);
}

// ── MP3 builders ──────────────────────────────────────────────────────────────

function synchsafe(n: number): [number, number, number, number] {
  return [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
}

/** A single ID3v2.3 text frame: 4-char id, plain u32 size, 2 flag bytes, enc byte + text. */
function id3v23Frame(id: string, text: string): number[] {
  const body = [0x00, ...[...text].map((c) => c.charCodeAt(0))]; // 0x00 = ISO-8859-1
  const size = body.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (size >> 24) & 0xff,
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    0x00,
    0x00,
    ...body,
  ];
}

/** A single ID3v2.2 text frame: 3-char id, u24 size, enc byte + text. */
function id3v22Frame(id: string, text: string): number[] {
  const body = [0x00, ...[...text].map((c) => c.charCodeAt(0))];
  const size = body.length;
  return [
    ...[...id].map((c) => c.charCodeAt(0)),
    (size >> 16) & 0xff,
    (size >> 8) & 0xff,
    size & 0xff,
    ...body,
  ];
}

/** Build an ID3v2 tag ("ID3" + version + synchsafe size + frames), no trailing audio. */
function id3Tag(major: number, frames: number[]): Uint8Array {
  const [s0, s1, s2, s3] = synchsafe(frames.length);
  return new Uint8Array([
    0x49, 0x44, 0x33, major, 0x00, 0x00, s0, s1, s2, s3, ...frames,
  ]);
}

/** MPEG1 Layer III frame header (128 kbps, 44100 Hz) optionally followed by a Xing frame count. */
function mpegFrame(opts: { xingFrames?: number; trailingBytes?: number } = {}): Uint8Array {
  const header = [0xff, 0xfb, 0x90, 0x00]; // sync, MPEG1/L3, 128k/44100
  const sideInfo = new Array(32).fill(0); // MPEG1 side-info block before Xing
  let xing: number[] = [];
  if (opts.xingFrames !== undefined) {
    const f = opts.xingFrames;
    xing = [
      0x58, 0x69, 0x6e, 0x67, // "Xing"
      0x00, 0x00, 0x00, 0x01, // flags: frames-present
      (f >> 24) & 0xff, (f >> 16) & 0xff, (f >> 8) & 0xff, f & 0xff,
    ];
  }
  const trailing = new Array(opts.trailingBytes ?? 0).fill(0);
  return new Uint8Array([...header, ...sideInfo, ...xing, ...trailing]);
}

// ── FLAC tests ──────────────────────────────────────────────────────────────

describe("parseFlac", () => {
  it("extracts tags + duration from STREAMINFO and VORBIS_COMMENT", () => {
    const file = flacFile([
      { type: 0, data: streamInfo(44100, 44100 * 180) }, // 180 s
      {
        type: 4,
        data: vorbisComment("ref libFLAC", [
          "TITLE=Hello World",
          "ARTIST=The Artist",
          "ALBUM=An Album",
          "ALBUMARTIST=Various Artists",
          "TRACKNUMBER=3/12",
          "DISCNUMBER=1",
          "DATE=2024-05-01",
          "GENRE=Rock",
        ]),
      },
    ]);
    expect(parseFlac(file)).toEqual({
      durationSec: 180,
      title: "Hello World",
      artist: "The Artist",
      album: "An Album",
      albumArtist: "Various Artists",
      trackNo: 3,
      discNo: 1,
      year: 2024,
      genre: "Rock",
    });
  });

  it("returns {} for a non-FLAC buffer", () => {
    expect(parseFlac(new Uint8Array([0x00, 0x01, 0x02, 0x03]))).toEqual({});
  });

  it("falls back to 'album artist' spelling for albumArtist", () => {
    const file = flacFile([
      { type: 4, data: vorbisComment("v", ["ALBUM ARTIST=Spaced Name"]) },
    ]);
    expect(parseFlac(file).albumArtist).toBe("Spaced Name");
  });

  it("is case-insensitive on comment keys", () => {
    const file = flacFile([
      { type: 4, data: vorbisComment("v", ["title=lowercase key"]) },
    ]);
    expect(parseFlac(file).title).toBe("lowercase key");
  });

  it("omits duration when STREAMINFO is absent", () => {
    const file = flacFile([
      { type: 4, data: vorbisComment("v", ["TITLE=x"]) },
    ]);
    expect(parseFlac(file).durationSec).toBeUndefined();
  });
});

// ── MP3 tests ───────────────────────────────────────────────────────────────

describe("parseMp3", () => {
  it("reads ID3v2.3 text frames", () => {
    const tag = id3Tag(3, [
      ...id3v23Frame("TIT2", "A Song"),
      ...id3v23Frame("TPE1", "An Artist"),
      ...id3v23Frame("TALB", "An Album"),
      ...id3v23Frame("TRCK", "5/10"),
      ...id3v23Frame("TYER", "1999"),
    ]);
    const tags = parseMp3(tag, tag.length);
    expect(tags.title).toBe("A Song");
    expect(tags.artist).toBe("An Artist");
    expect(tags.album).toBe("An Album");
    expect(tags.trackNo).toBe(5);
    expect(tags.year).toBe(1999);
  });

  it("reads ID3v2.2 (3-char) frames", () => {
    const tag = id3Tag(2, [
      ...id3v22Frame("TT2", "Legacy Title"),
      ...id3v22Frame("TP1", "Legacy Artist"),
    ]);
    const tags = parseMp3(tag, tag.length);
    expect(tags.title).toBe("Legacy Title");
    expect(tags.artist).toBe("Legacy Artist");
  });

  it("derives exact duration from a Xing header", () => {
    // 7000 frames * 1152 samples / 44100 Hz ≈ 182.86 → 183 s
    const file = mpegFrame({ xingFrames: 7000, trailingBytes: 8 });
    const tags = parseMp3(file, file.length);
    expect(tags.durationSec).toBe(183);
    expect(tags.bitrateKbps).toBe(128);
  });

  it("falls back to CBR math when there is no Xing header", () => {
    const file = mpegFrame({ trailingBytes: 32 }); // no Xing tag present
    // audioBytes = fileSize; round(160000 * 8 / (128 * 1000)) = 10 s
    const tags = parseMp3(file, 160000);
    expect(tags.durationSec).toBe(10);
    expect(tags.bitrateKbps).toBe(128);
  });

  it("combines an ID3 tag with a following audio frame for duration", () => {
    const tag = id3Tag(3, id3v23Frame("TIT2", "Tagged"));
    const frame = mpegFrame({ xingFrames: 7000, trailingBytes: 8 });
    const file = new Uint8Array([...tag, ...frame]);
    const tags = parseMp3(file, file.length);
    expect(tags.title).toBe("Tagged");
    expect(tags.durationSec).toBe(183);
  });

  it("returns {} for bytes with neither ID3 nor a frame sync", () => {
    expect(parseMp3(new Uint8Array(64), 64)).toEqual({});
  });
});

// ── dispatch ──────────────────────────────────────────────────────────────

describe("parseTags dispatch", () => {
  it("knows which extensions are parsable", () => {
    expect(isParsable("flac")).toBe(true);
    expect(isParsable("mp3")).toBe(true);
    expect(isParsable("ogg")).toBe(false);
    expect(isParsable("wav")).toBe(false);
  });

  it("routes flac/mp3 and returns {} for unknown extensions", () => {
    const flac = flacFile([{ type: 4, data: vorbisComment("v", ["TITLE=F"]) }]);
    expect(parseTags(flac, "flac", flac.length).title).toBe("F");
    const mp3 = id3Tag(3, id3v23Frame("TIT2", "M"));
    expect(parseTags(mp3, "mp3", mp3.length).title).toBe("M");
    expect(parseTags(flac, "ogg", flac.length)).toEqual({});
  });
});
