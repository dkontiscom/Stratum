// SPDX-License-Identifier: MIT
//
// MP3 parser. Two independent jobs:
//   1. ID3v2 (v2.2 / v2.3 / v2.4) text frames at the start of the file → tags.
//   2. Duration: prefer a Xing/Info VBR header (exact frame count); otherwise fall back to
//      CBR math (fileSize - tagSize) * 8 / bitrate, which is why parseMp3 takes fileSize.
// Best-effort throughout: anything unparseable just leaves fields undefined.

import type { AudioTags } from "../../shared/types";

/** 28-bit synchsafe integer (ID3 sizes, v2.4 frame sizes). */
function synchsafe(b: Uint8Array, o: number): number {
  return (b[o] << 21) | (b[o + 1] << 14) | (b[o + 2] << 7) | b[o + 3];
}
function u32(b: Uint8Array, o: number): number {
  return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
}

function decodeText(frame: Uint8Array): string {
  if (frame.length === 0) return "";
  const encoding = frame[0];
  const body = frame.subarray(1);
  let label = "utf-8";
  if (encoding === 0) label = "iso-8859-1";
  else if (encoding === 1) label = "utf-16"; // has BOM
  else if (encoding === 2) label = "utf-16be";
  let text: string;
  try {
    text = new TextDecoder(label).decode(body);
  } catch {
    text = new TextDecoder("iso-8859-1").decode(body);
  }
  // strip trailing NULs and any embedded terminators
  return text.replace(/\u0000+$/g, "").split("\u0000")[0].trim();
}

function intOf(s: string | undefined): number | undefined {
  if (!s) return undefined;
  const m = s.match(/\d+/);
  return m ? parseInt(m[0], 10) : undefined;
}

// Frame-id → AudioTags field, for both v2.3/2.4 (4-char) and v2.2 (3-char).
const FRAME_MAP: Record<string, keyof AudioTags> = {
  TIT2: "title", TT2: "title",
  TPE1: "artist", TP1: "artist",
  TALB: "album", TAL: "album",
  TPE2: "albumArtist", TP2: "albumArtist",
  TCON: "genre", TCO: "genre",
  TRCK: "trackNo", TRK: "trackNo",
  TPOS: "discNo", TPA: "discNo",
  TYER: "year", TYE: "year", TDRC: "year", TDA: "year",
};

function readId3v2(bytes: Uint8Array): { tags: AudioTags; tagSize: number } {
  const tags: AudioTags = {};
  if (bytes.length < 10 || bytes[0] !== 0x49 || bytes[1] !== 0x44 || bytes[2] !== 0x33) {
    return { tags, tagSize: 0 }; // no "ID3"
  }
  const major = bytes[3];
  const size = synchsafe(bytes, 6); // excludes the 10-byte header
  const tagSize = size + 10;
  const idLen = major === 2 ? 3 : 4; // v2.2 uses 3-char frame ids
  const headerLen = major === 2 ? 6 : 10;
  const end = Math.min(tagSize, bytes.length);

  let p = 10;
  while (p + headerLen <= end) {
    const id = String.fromCharCode(...bytes.subarray(p, p + idLen));
    if (!/^[A-Z0-9]+$/.test(id)) break; // hit padding / end of frames
    let frameSize: number;
    if (major === 2) {
      frameSize = (bytes[p + 3] << 16) | (bytes[p + 4] << 8) | bytes[p + 5];
    } else if (major === 4) {
      frameSize = synchsafe(bytes, p + 4); // v2.4 sizes are synchsafe
    } else {
      frameSize = u32(bytes, p + 4); // v2.3 plain u32
    }
    const dataStart = p + headerLen;
    if (frameSize <= 0 || dataStart + frameSize > end) break;

    const field = FRAME_MAP[id];
    if (field && id[0] === "T") {
      const value = decodeText(bytes.subarray(dataStart, dataStart + frameSize));
      if (value) {
        if (field === "trackNo" || field === "discNo" || field === "year") {
          const n = intOf(value);
          if (n !== undefined) (tags[field] as number) = n;
        } else {
          (tags[field] as string) = value;
        }
      }
    }
    p = dataStart + frameSize;
  }
  return { tags, tagSize };
}

// MPEG audio frame-header tables (Layer III is all we meet in .mp3).
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0];
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0];
const SAMPLE_RATES: Record<number, number[]> = {
  3: [44100, 48000, 32000, 0], // MPEG1
  2: [22050, 24000, 16000, 0], // MPEG2
  0: [11025, 12000, 8000, 0], // MPEG2.5
};

/** Compute duration from the first audio frame after `offset`. Uses Xing/Info if present. */
function readDuration(bytes: Uint8Array, offset: number, fileSize: number): { durationSec?: number; bitrateKbps?: number } {
  // find frame sync (11 bits set) within a small window after the ID3 tag
  let p = offset;
  const limit = Math.min(bytes.length - 4, offset + 8192);
  for (; p <= limit; p++) {
    if (bytes[p] === 0xff && (bytes[p + 1] & 0xe0) === 0xe0) break;
  }
  if (p > limit) return {};

  const h1 = bytes[p + 1], h2 = bytes[p + 2];
  const versionBits = (h1 >> 3) & 0x03; // 3=MPEG1, 2=MPEG2, 0=MPEG2.5
  const layerBits = (h1 >> 1) & 0x03; // 1 = Layer III
  const brIndex = (h2 >> 4) & 0x0f;
  const srIndex = (h2 >> 2) & 0x03;
  if (layerBits !== 1 || versionBits === 1) return {}; // only Layer III, reserved version out
  const table = versionBits === 3 ? BITRATES_V1_L3 : BITRATES_V2_L3;
  const bitrate = table[brIndex];
  const sampleRate = SAMPLE_RATES[versionBits]?.[srIndex] ?? 0;
  if (!bitrate || !sampleRate) return {};
  const samplesPerFrame = versionBits === 3 ? 1152 : 576;

  // Xing/Info header sits inside the first frame, after the side-info block.
  const xingOffset = p + 4 + (versionBits === 3 ? 32 : 17);
  if (xingOffset + 12 <= bytes.length) {
    const tag = String.fromCharCode(...bytes.subarray(xingOffset, xingOffset + 4));
    if (tag === "Xing" || tag === "Info") {
      const flags = u32(bytes, xingOffset + 4);
      if (flags & 0x01) {
        const frames = u32(bytes, xingOffset + 8);
        const durationSec = Math.round((frames * samplesPerFrame) / sampleRate);
        return { durationSec, bitrateKbps: bitrate };
      }
    }
  }

  // CBR fallback: audio bytes / bitrate.
  const audioBytes = fileSize - offset;
  const durationSec = audioBytes > 0 ? Math.round((audioBytes * 8) / (bitrate * 1000)) : undefined;
  return { durationSec, bitrateKbps: bitrate };
}

export function parseMp3(bytes: Uint8Array, fileSize: number): AudioTags {
  const { tags, tagSize } = readId3v2(bytes);
  const { durationSec, bitrateKbps } = readDuration(bytes, tagSize, fileSize);
  if (durationSec !== undefined) tags.durationSec = durationSec;
  if (bitrateKbps !== undefined) tags.bitrateKbps = bitrateKbps;
  return tags;
}
