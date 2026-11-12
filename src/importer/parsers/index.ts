// SPDX-License-Identifier: MIT
// Parser dispatch. v1 understands FLAC + MP3; other audio extensions parse to {} (the file is
// still registered, just with filename-derived metadata). Pure functions: bytes in, tags out.

import type { AudioTags } from "../../shared/types";
import { parseFlac } from "./flac";
import { parseMp3 } from "./mp3";

/** How many leading bytes the importer should range-read for header parsing. */
export const HEADER_BYTES = 256 * 1024;

/** Which extensions v1 can actually read tags from (others are registered without tags). */
export function isParsable(ext: string): boolean {
  return ext === "flac" || ext === "mp3";
}

/**
 * @param bytes    leading bytes of the object (>= HEADER_BYTES, or the whole file if smaller)
 * @param ext      lowercased extension without the dot
 * @param fileSize total object size in bytes (MP3 CBR duration needs it)
 */
export function parseTags(bytes: Uint8Array, ext: string, fileSize: number): AudioTags {
  switch (ext) {
    case "flac":
      return parseFlac(bytes);
    case "mp3":
      return parseMp3(bytes, fileSize);
    default:
      return {};
  }
}

export { parseFlac, parseMp3 };
