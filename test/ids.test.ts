// SPDX-License-Identifier: MIT
// Tests for the ID contract (src/shared/ids.ts) — the single source of truth that
// server + importer both depend on. If any of these change, existing stars/ratings/
// playlists silently break, so the invariants are pinned here deliberately.

import { describe, it, expect } from "vitest";
import {
  stableId,
  normalizeName,
  pathStem,
  artistId,
  albumId,
  trackId,
  trackFileId,
} from "../src/shared/ids";

describe("stableId", () => {
  it("is 24 hex chars", async () => {
    const id = await stableId("anything");
    expect(id).toMatch(/^[0-9a-f]{24}$/);
  });

  it("is deterministic for the same input", async () => {
    expect(await stableId("foo")).toBe(await stableId("foo"));
  });

  it("differs for different input", async () => {
    expect(await stableId("foo")).not.toBe(await stableId("bar"));
  });
});

describe("normalizeName", () => {
  it("trims, collapses whitespace, lowercases", () => {
    expect(normalizeName("  The   Beatles  ")).toBe("the beatles");
  });

  it("treats null/undefined as empty", () => {
    expect(normalizeName(undefined as unknown as string)).toBe("");
    expect(normalizeName(null as unknown as string)).toBe("");
  });
});

describe("pathStem", () => {
  it("drops a leading slash, lowercases, strips the extension", () => {
    expect(pathStem("/Music/Album/01 Song.FLAC")).toBe("music/album/01 song");
  });

  it("maps same stem with different extension to the same value", () => {
    expect(pathStem("A/B/01.flac")).toBe(pathStem("A/B/01.mp3"));
  });

  it("keeps dots in directory names, only strips the final segment's extension", () => {
    expect(pathStem("a.b/c.d/track.mp3")).toBe("a.b/c.d/track");
  });

  it("handles a bare filename with no directory", () => {
    expect(pathStem("song.mp3")).toBe("song");
  });

  it("does not strip a leading-dot filename with no real extension", () => {
    // dot at index 0 → `dot > 0` is false → nothing stripped
    expect(pathStem(".hidden")).toBe(".hidden");
  });
});

describe("id derivation", () => {
  it("artistId is normalization-insensitive", async () => {
    expect(await artistId("The Beatles")).toBe(await artistId("  the   beatles "));
  });

  it("albumId depends on both artist and album", async () => {
    const a = await albumId("Pink Floyd", "Animals");
    expect(a).toBe(await albumId("pink floyd", "animals"));
    expect(a).not.toBe(await albumId("Pink Floyd", "Meddle"));
  });

  it("trackId is extension-independent (flac == mp3 for the same stem)", async () => {
    expect(await trackId("Album/01.flac")).toBe(await trackId("Album/01.mp3"));
  });

  it("trackId distinguishes different paths", async () => {
    expect(await trackId("Album/01.flac")).not.toBe(await trackId("Album/02.flac"));
  });

  it("trackFileId is exact (NOT normalized): backend + key, case-sensitive", async () => {
    const a = await trackFileId("garage-home", "Album/01.flac");
    expect(a).not.toBe(await trackFileId("garage-home", "album/01.flac")); // case matters
    expect(a).not.toBe(await trackFileId("r2-cache", "Album/01.flac")); // backend matters
    expect(a).toBe(await trackFileId("garage-home", "Album/01.flac")); // stable
  });

  it("different id namespaces never collide for the same name", async () => {
    // artist:/album:/track: prefixes keep the spaces disjoint
    const name = "x";
    const ids = new Set([
      await artistId(name),
      await albumId(name, name),
      await trackId(name),
    ]);
    expect(ids.size).toBe(3);
  });
});
