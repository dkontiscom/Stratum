// SPDX-License-Identifier: MIT
//
// FLAC header parser. Reads the metadata block chain from the start of the file:
//   STREAMINFO (type 0)     → sample rate + total samples → duration
//   VORBIS_COMMENT (type 4) → ARTIST / ALBUM / TITLE / DATE / … tags
// We only need the first few blocks, so a ~256 KiB head read is plenty for normal files.
// Everything is best-effort: a missing/short block just leaves those fields undefined.

import type { AudioTags } from "../../shared/types";

/** Big-endian u24. */
function u24(b: Uint8Array, o: number): number {
  return (b[o] << 16) | (b[o + 1] << 8) | b[o + 2];
}

/** Parse STREAMINFO (34 bytes) → { sampleRate, totalSamples }. */
function readStreamInfo(si: Uint8Array): { sampleRate: number; totalSamples: number } {
  // bytes 10..17 pack: 20b sample rate | 3b channels | 5b bps | 36b total samples
  const sampleRate = (si[10] << 12) | (si[11] << 4) | (si[12] >> 4);
  const hi = si[12] & 0x0f; // top 4 bits of the 36-bit sample count
  const lo = si[13] * 2 ** 24 + (si[14] << 16) + (si[15] << 8) + si[16];
  const totalSamples = hi * 2 ** 32 + lo;
  return { sampleRate, totalSamples };
}

/** Parse a VORBIS_COMMENT block (little-endian) into a lowercased key→value map. */
function readVorbisComments(block: Uint8Array): Map<string, string> {
  const out = new Map<string, string>();
  const dv = new DataView(block.buffer, block.byteOffset, block.byteLength);
  const dec = new TextDecoder("utf-8");
  let p = 0;
  const vendorLen = dv.getUint32(p, true);
  p += 4 + vendorLen;
  if (p + 4 > block.byteLength) return out;
  const count = dv.getUint32(p, true);
  p += 4;
  for (let i = 0; i < count; i++) {
    if (p + 4 > block.byteLength) break;
    const len = dv.getUint32(p, true);
    p += 4;
    if (p + len > block.byteLength) break;
    const entry = dec.decode(block.subarray(p, p + len));
    p += len;
    const eq = entry.indexOf("=");
    if (eq <= 0) continue;
    const key = entry.slice(0, eq).toLowerCase();
    const val = entry.slice(eq + 1);
    if (!out.has(key)) out.set(key, val); // first wins (ignores repeated multi-value tags)
  }
  return out;
}

function intOf(s: string | undefined): number | undefined {
  if (!s) return undefined;
  // "3/12" (track/total) or "2024-05" → leading integer
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

export function parseFlac(bytes: Uint8Array): AudioTags {
  const tags: AudioTags = {};
  if (bytes.length < 4 || bytes[0] !== 0x66 || bytes[1] !== 0x4c || bytes[2] !== 0x61 || bytes[3] !== 0x43) {
    return tags; // not "fLaC"
  }

  let p = 4;
  let comments: Map<string, string> | undefined;
  while (p + 4 <= bytes.length) {
    const header = bytes[p];
    const last = (header & 0x80) !== 0;
    const type = header & 0x7f;
    const len = u24(bytes, p + 1);
    const dataStart = p + 4;
    if (dataStart + len > bytes.length) break; // block truncated by our head read

    if (type === 0 && len >= 18) {
      const { sampleRate, totalSamples } = readStreamInfo(bytes.subarray(dataStart, dataStart + len));
      if (sampleRate > 0 && totalSamples > 0) tags.durationSec = Math.round(totalSamples / sampleRate);
    } else if (type === 4) {
      comments = readVorbisComments(bytes.subarray(dataStart, dataStart + len));
    }

    if (last) break;
    p = dataStart + len;
  }

  if (comments) {
    tags.title = comments.get("title") || undefined;
    tags.artist = comments.get("artist") || undefined;
    tags.album = comments.get("album") || undefined;
    tags.albumArtist = comments.get("albumartist") || comments.get("album artist") || undefined;
    tags.genre = comments.get("genre") || undefined;
    tags.trackNo = intOf(comments.get("tracknumber"));
    tags.discNo = intOf(comments.get("discnumber"));
    tags.year = intOf(comments.get("date") || comments.get("year") || comments.get("originaldate"));
  }
  return tags;
}
