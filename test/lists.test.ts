// SPDX-License-Identifier: MIT
// Search + list browsing against a richer seeded D1 (three albums across two genres and a
// spread of years): search2/search3 LIKE matching, getAlbumList2 filter types (byYear,
// byGenre, alphabeticalByName, size cap), getGenres aggregation, getSongsByGenre, and
// getRandomSongs genre filtering.

import { describe, it, expect, beforeAll } from "vitest";
import { applySchema, seedLibrary, callJson, ALICE, testEnv } from "./helpers";

beforeAll(async () => {
  await applySchema();
  await seedLibrary(); // art1 "The Beatles" / alb1 "Abbey Road" (1969) / trk1 "Come Together"
  await testEnv.DB.batch([
    testEnv.DB.prepare("UPDATE albums SET genre = 'Rock' WHERE id = 'alb1'"),
    testEnv.DB.prepare("UPDATE tracks SET genre = 'Rock' WHERE id = 'trk1'"),
    testEnv.DB.prepare("INSERT INTO artists (id, name) VALUES ('art2','Pink Floyd'),('art3','Daft Punk')"),
    testEnv.DB.prepare(
      `INSERT INTO albums (id, name, artist_id, artist_name, year, genre) VALUES
         ('alb2','Animals','art2','Pink Floyd',1977,'Rock'),
         ('alb3','Discovery','art3','Daft Punk',2001,'Electronic')`
    ),
    testEnv.DB.prepare(
      `INSERT INTO tracks (id, title, album_id, album_name, artist_id, artist_name, genre, duration) VALUES
         ('trk2','Dogs','alb2','Animals','art2','Pink Floyd','Rock',200),
         ('trk3','One More Time','alb3','Discovery','art3','Daft Punk','Electronic',320)`
    ),
  ]);
});

describe("search3 / search2", () => {
  it("matches artists, albums, and songs by substring", async () => {
    const r = await callJson("search3", { query: "Beatles", ...ALICE() });
    expect(r.searchResult3.artist.map((a: { name: string }) => a.name)).toContain("The Beatles");
    // "Abbey Road" matches via artist_name, and the song via its artist_name too.
    expect(r.searchResult3.song.map((s: { title: string }) => s.title)).toContain("Come Together");
  });

  it("matches an album by its own name", async () => {
    const r = await callJson("search3", { query: "Animals", ...ALICE() });
    expect(r.searchResult3.album.map((a: { name: string }) => a.name)).toContain("Animals");
  });

  it("returns empty result sets for a non-matching query", async () => {
    const r = await callJson("search3", { query: "zzzznomatch", ...ALICE() });
    expect(r.searchResult3.artist ?? []).toHaveLength(0);
    expect(r.searchResult3.album ?? []).toHaveLength(0);
    expect(r.searchResult3.song ?? []).toHaveLength(0);
  });

  it("search2 serves the same hits under searchResult2", async () => {
    const r = await callJson("search2", { query: "Daft", ...ALICE() });
    expect(r.searchResult2.artist.map((a: { name: string }) => a.name)).toContain("Daft Punk");
  });
});

describe("search wildcard escaping", () => {
  const albumNames = (r: Record<string, any>) =>
    (r.searchResult3.album ?? []).map((a: { name: string }) => a.name);

  it("treats a literal % in the query as a character, not a wildcard", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO albums (id, name, artist_id, artist_name) VALUES
           ('albp','100% Pure','art1','The Beatles'),
           ('albt','1000 Songs','art1','The Beatles')`
      ),
    ]);
    const r = await callJson("search3", { query: "100%", ...ALICE() });
    const got = albumNames(r);
    expect(got).toContain("100% Pure");
    expect(got).not.toContain("1000 Songs");
  });

  it("still does ordinary substring matching", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO albums (id, name, artist_id, artist_name) VALUES
           ('albp','100% Pure','art1','The Beatles'),
           ('albt','1000 Songs','art1','The Beatles')`
      ),
    ]);
    const r = await callJson("search3", { query: "Pure", ...ALICE() });
    expect(albumNames(r)).toContain("100% Pure");
  });

  it("treats a literal _ in the query as a character, not a wildcard", async () => {
    await testEnv.DB.batch([
      testEnv.DB.prepare(
        `INSERT INTO albums (id, name, artist_id, artist_name) VALUES
           ('alu','a_b side','art1','The Beatles'),
           ('alx','axb side','art1','The Beatles')`
      ),
    ]);
    const r = await callJson("search3", { query: "a_b", ...ALICE() });
    const got = albumNames(r);
    expect(got).toContain("a_b side");
    expect(got).not.toContain("axb side");
  });
});

describe("getAlbumList2 filters", () => {
  const names = (r: Record<string, any>) => r.albumList2.album.map((a: { name: string }) => a.name);

  it("byYear returns albums within [fromYear, toYear]", async () => {
    const r = await callJson("getAlbumList2", { type: "byYear", fromYear: "1970", toYear: "2010", ...ALICE() });
    const got = names(r);
    expect(got).toContain("Animals"); // 1977
    expect(got).toContain("Discovery"); // 2001
    expect(got).not.toContain("Abbey Road"); // 1969, out of range
  });

  it("byGenre returns only that genre", async () => {
    const r = await callJson("getAlbumList2", { type: "byGenre", genre: "Electronic", ...ALICE() });
    expect(names(r)).toEqual(["Discovery"]);
  });

  it("alphabeticalByName is name-ordered", async () => {
    const r = await callJson("getAlbumList2", { type: "alphabeticalByName", ...ALICE() });
    expect(names(r)).toEqual(["Abbey Road", "Animals", "Discovery"]);
  });

  it("honours the size cap", async () => {
    const r = await callJson("getAlbumList2", { type: "alphabeticalByName", size: "1", ...ALICE() });
    expect(r.albumList2.album).toHaveLength(1);
  });
});

describe("getGenres / getSongsByGenre / getRandomSongs", () => {
  it("getGenres aggregates song + album counts per genre", async () => {
    const r = await callJson("getGenres", ALICE());
    const rock = r.genres.genre.find((g: { value: string }) => g.value === "Rock");
    const electronic = r.genres.genre.find((g: { value: string }) => g.value === "Electronic");
    expect(rock).toMatchObject({ songCount: 2, albumCount: 2 }); // trk1+trk2, alb1+alb2
    expect(electronic).toMatchObject({ songCount: 1, albumCount: 1 });
  });

  it("getSongsByGenre returns the genre's songs", async () => {
    const r = await callJson("getSongsByGenre", { genre: "Electronic", ...ALICE() });
    expect(r.songsByGenre.song.map((s: { title: string }) => s.title)).toEqual(["One More Time"]);
  });

  it("getRandomSongs filtered by genre only returns that genre's tracks", async () => {
    const r = await callJson("getRandomSongs", { genre: "Rock", size: "10", ...ALICE() });
    const ids = r.randomSongs.song.map((s: { id: string }) => s.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids)).toEqual(new Set(["trk1", "trk2"]));
  });
});
