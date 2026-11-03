import test from "node:test";
import assert from "node:assert/strict";
import { applyStremioProgress, stremioLibraryItemToProgress } from "./stremioAccount.js";

const NOW = "2026-11-03T20:00:00.000Z";
const MIN = 60 * 1000;

test("new movie playback creates a temp Continue Watching item", () => {
  const item = applyStremioProgress(null, {
    contentId: "tt0111161",
    contentType: "movie",
    title: "The Shawshank Redemption",
    positionMs: 30 * MIN,
    durationMs: 140 * MIN
  }, NOW);
  assert.equal(item._id, "tt0111161");
  assert.equal(item.type, "movie");
  assert.equal(item.temp, true);
  assert.equal(item.removed, true);
  assert.equal(item.state.timeOffset, 30 * MIN);
  assert.equal(item.state.video_id, "tt0111161");
  assert.equal(item._mtime, NOW);

  const progress = stremioLibraryItemToProgress(item);
  assert.equal(progress.contentId, "tt0111161");
  assert.equal(progress.positionMs, 30 * MIN);
  assert.equal(progress.durationMs, 140 * MIN);
  assert.equal(progress.updatedAt, Date.parse(NOW));
});

test("same episode accumulates watch time; crossing credits resets offset and flags watched", () => {
  const start = applyStremioProgress(null, {
    contentId: "tt0903747",
    contentType: "series",
    videoId: "tt0903747:1:2",
    positionMs: 0,
    durationMs: 50 * MIN
  }, NOW);
  const mid = applyStremioProgress(start, {
    contentId: "tt0903747", contentType: "series", videoId: "tt0903747:1:2",
    positionMs: 40 * MIN, durationMs: 50 * MIN
  }, NOW);
  assert.equal(mid.state.timeWatched, 40 * MIN);
  assert.equal(mid.state.flaggedWatched, 1);
  assert.equal(mid.state.timesWatched, 1);
  assert.ok(stremioLibraryItemToProgress(mid), "temp items stay in Continue Watching like stremio-core");

  const end = applyStremioProgress(mid, {
    contentId: "tt0903747", contentType: "series", videoId: "tt0903747:1:2",
    positionMs: 48 * MIN, durationMs: 50 * MIN
  }, NOW);
  assert.equal(end.state.timeOffset, 0);
  assert.equal(stremioLibraryItemToProgress(end), null);
});

test("existing library item keeps its library membership and maps season/episode", () => {
  const row = {
    _id: "tt0903747", name: "Breaking Bad", type: "series", removed: false, temp: false,
    _mtime: "2026-01-01T00:00:00.000Z",
    state: { timeOffset: 10 * MIN, duration: 50 * MIN, video_id: "tt0903747:2:3", timeWatched: 10 * MIN,
      lastWatched: "2026-10-01T00:00:00.000Z", timesWatched: 4, flaggedWatched: 0, overallTimeWatched: 0 }
  };
  const progress = stremioLibraryItemToProgress(row);
  assert.equal(progress.season, 2);
  assert.equal(progress.episode, 3);
  assert.equal(progress.videoId, "tt0903747:2:3");

  const next = applyStremioProgress(row, {
    contentId: "tt0903747", contentType: "series", videoId: "tt0903747:2:4",
    positionMs: 5 * MIN, durationMs: 50 * MIN
  }, NOW);
  assert.equal(next.removed, false);
  assert.equal(next.temp, false);
  assert.equal(next.state.video_id, "tt0903747:2:4");
  assert.equal(next.state.timeWatched, 0, "new video resets per-video watch time");
  assert.equal(next.state.overallTimeWatched, 10 * MIN);
  assert.equal(row.state.video_id, "tt0903747:2:3", "input row is not mutated");
});

test("removed non-temp and 'other' items never reach Continue Watching", () => {
  const base = { _id: "tt1", name: "x", _mtime: NOW, state: { timeOffset: 1000, duration: 5000 } };
  assert.equal(stremioLibraryItemToProgress({ ...base, type: "movie", removed: true, temp: false }), null);
  assert.equal(stremioLibraryItemToProgress({ ...base, type: "other", removed: false, temp: false }), null);
  assert.ok(stremioLibraryItemToProgress({ ...base, type: "movie", removed: true, temp: true }));
});

test("pushProgress writes the updated item to Stremio's datastore and throttles checkpoints", async () => {
  const store = new Map([["stremioAuthState", JSON.stringify({ 1: { authKey: "k", email: "e" } })]]);
  globalThis.localStorage ??= {
    getItem: (key) => (store.has(key) ? store.get(key) : null),
    setItem: (key, value) => store.set(key, String(value)),
    removeItem: (key) => store.delete(key),
    clear: () => store.clear()
  };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ method: String(url).split("/api/")[1], body });
    const result = String(url).endsWith("datastoreGet") ? [] : { success: true };
    return new Response(JSON.stringify({ result }), { status: 200 });
  };
  const { StremioAccount } = await import("./stremioAccount.js");
  const progress = { contentId: "tt0111161", contentType: "movie", title: "S", positionMs: 10 * MIN, durationMs: 140 * MIN };

  assert.equal(await StremioAccount.pushProgress(progress), true);
  assert.equal(await StremioAccount.pushProgress({ ...progress, positionMs: 11 * MIN }), false, "checkpoint within 30s is skipped");
  assert.equal(await StremioAccount.pushProgress({ ...progress, positionMs: 12 * MIN }, { force: true }), true);

  const puts = calls.filter((call) => call.method === "datastorePut");
  assert.equal(puts.length, 2);
  assert.equal(puts[0].body.authKey, "k");
  assert.equal(puts[0].body.collection, "libraryItem");
  assert.equal(puts[1].body.changes[0].state.timeOffset, 12 * MIN);
  assert.equal(puts[1].body.changes[0].state.timeWatched, 2 * MIN, "first tick of a new video counts 0, like stremio-core");
  assert.equal(calls.filter((call) => call.method === "datastoreGet").length, 1, "library fetched once then cached");
});
