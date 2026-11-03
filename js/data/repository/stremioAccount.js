import { LocalStore } from "../../core/storage/localStore.js";
import { ProfileManager } from "../../core/profile/profileManager.js";
import { registerSessionTeardownHandler } from "../../core/auth/sessionLifecycle.js";

// Endpoints and LibraryItem rules mirror Stremio/stremio-core (types/api, models/player.rs).
const API_URL = "https://api.strem.io/api/";
const LINK_URL = "https://link.stremio.com/api/v2/";
const STORE_KEY = "stremioAuthState";
const LIBRARY_TTL_MS = 60 * 1000;
const PUSH_INTERVAL_MS = 30 * 1000;
const WATCHED_THRESHOLD_COEF = 0.7;
const CREDITS_THRESHOLD_COEF = 0.9;
const SESSION_MISSING_CODE = 1;

const libraries = new Map();
const lastPushAt = new Map();
let pushQueue = Promise.resolve();

function profileId() {
  return String(ProfileManager.getActiveProfileId() || "1");
}

function readAll() {
  const raw = LocalStore.get(STORE_KEY, null);
  return raw && typeof raw === "object" ? raw : {};
}

function readAuth(pid = profileId()) {
  const state = readAll()[pid];
  return state?.authKey ? state : null;
}

function writeAuth(value, pid = profileId()) {
  const all = readAll();
  if (value) all[pid] = value;
  else delete all[pid];
  LocalStore.set(STORE_KEY, all);
}

async function call(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (payload?.error) {
    const error = new Error(payload.error.message || "Stremio error");
    error.code = payload.error.code;
    throw error;
  }
  if (!response.ok || !payload || !("result" in payload)) {
    throw new Error(`Stremio HTTP ${response.status}`);
  }
  return payload.result;
}

async function api(method, body = {}, pid = profileId()) {
  const auth = readAuth(pid);
  if (!auth) throw new Error("Stremio is not connected");
  try {
    return await call(API_URL + method, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...body, authKey: auth.authKey })
    });
  } catch (error) {
    // Logged out elsewhere: drop the dead key so the UI offers to reconnect.
    if (error.code === SESSION_MISSING_CODE) StremioAccount.disconnect(pid);
    throw error;
  }
}

function link(method, query) {
  return call(`${LINK_URL}${method}?${new URLSearchParams(query)}`, { method: "GET" });
}

function nowIso() {
  return new Date().toISOString();
}

export function stremioLibraryItemToProgress(row) {
  const state = row?.state || {};
  const offset = Number(state.timeOffset || 0);
  // Same rule as LibraryItem::is_in_continue_watching.
  if (!row?._id || row.type === "other" || (row.removed && !row.temp) || !(offset > 0)) {
    return null;
  }
  const isSeries = row.type === "series";
  const videoId = String(state.video_id || row._id);
  const [, season, episode] = videoId.split(":");
  const duration = Number(state.duration || 0);
  return {
    contentId: row._id,
    contentType: isSeries ? "series" : "movie",
    imdbId: /^tt\d+$/.test(row._id) ? row._id : null,
    title: row.name || row._id,
    name: row.name || row._id,
    poster: row.poster || null,
    videoId: isSeries ? videoId : row._id,
    season: isSeries && season ? Number(season) : null,
    episode: isSeries && episode ? Number(episode) : null,
    positionMs: offset,
    durationMs: duration,
    progressPercent: duration > 0 ? Math.min(100, (offset / duration) * 100) : 0,
    updatedAt: Date.parse(state.lastWatched || row._mtime) || 0,
    source: "stremio_playback",
    trackingProviderId: "stremio"
  };
}

// A LibraryItem as stremio-core creates it before anything was watched.
function newLibraryItem(item, now) {
  const isSeries = String(item.contentType || "").toLowerCase() === "series";
  return {
    _id: item.contentId,
    name: item.title || item.contentId,
    type: isSeries ? "series" : "movie",
    poster: item.poster || null,
    posterShape: "poster",
    removed: true,
    temp: true,
    _ctime: now,
    _mtime: now,
    behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false },
    state: {
      lastWatched: null,
      timeWatched: 0,
      timeOffset: 0,
      overallTimeWatched: 0,
      timesWatched: 0,
      flaggedWatched: 0,
      duration: 0,
      video_id: null,
      watched: null,
      noNotif: false
    }
  };
}

// Applies one playback tick the way stremio-core's TimeChanged + unload handlers do.
export function applyStremioProgress(row, progress, now = nowIso()) {
  const isSeries = String(progress.contentType || "").toLowerCase() === "series";
  const videoId = String((isSeries && progress.videoId) || progress.contentId);
  const position = Math.max(0, Math.trunc(Number(progress.positionMs || 0)));
  const duration = Math.max(0, Math.trunc(Number(progress.durationMs || 0)));
  const item = row ? { ...row, state: { ...row.state } } : newLibraryItem(progress, now);
  const state = item.state;
  if (state.video_id !== videoId) {
    state.video_id = videoId;
    state.overallTimeWatched = Number(state.overallTimeWatched || 0) + Number(state.timeWatched || 0);
    state.timeWatched = 0;
    state.flaggedWatched = 0;
  } else {
    const delta = Math.max(0, position - Number(state.timeOffset || 0));
    state.timeWatched = Number(state.timeWatched || 0) + delta;
    state.overallTimeWatched = Number(state.overallTimeWatched || 0) + delta;
  }
  state.timeOffset = position;
  state.duration = duration;
  state.lastWatched = now;
  if (
    !state.flaggedWatched &&
    duration > 0 &&
    state.timeWatched > duration * WATCHED_THRESHOLD_COEF
  ) {
    state.flaggedWatched = 1;
    state.timesWatched = Number(state.timesWatched || 0) + 1;
  }
  if (duration > 0 && position > duration * CREDITS_THRESHOLD_COEF) state.timeOffset = 0;
  if (item.temp && !state.timesWatched) item.removed = true;
  if (item.removed) item.temp = true;
  item._mtime = now;
  return item;
}

async function loadLibrary({ force = false } = {}) {
  const pid = profileId();
  const cached = libraries.get(pid) || { items: new Map(), fetchedAt: 0, task: null };
  if (cached.task) return cached.task;
  if (!force && cached.fetchedAt && Date.now() - cached.fetchedAt < LIBRARY_TTL_MS) {
    return cached.items;
  }
  const task = api("datastoreGet", { collection: "libraryItem", ids: [], all: true }, pid)
    .then((rows) => {
      const items = new Map((Array.isArray(rows) ? rows : []).map((row) => [row._id, row]));
      libraries.set(pid, { items, fetchedAt: Date.now(), task: null });
      return items;
    })
    .catch((error) => {
      libraries.set(pid, { ...cached, task: null });
      throw error;
    });
  libraries.set(pid, { ...cached, task });
  return task;
}

export const StremioAccount = {
  connected(pid = profileId()) {
    return Boolean(readAuth(pid));
  },

  email(pid = profileId()) {
    return readAuth(pid)?.email || null;
  },

  async startLink() {
    const result = await link("create", { type: "Create" });
    return { code: result.code, url: result.link };
  },

  // Resolves true once the code was approved on link.stremio.com, false while pending.
  async pollLink(code, pid = profileId()) {
    let result;
    try {
      result = await link("read", { type: "Read", code });
    } catch (error) {
      if (error.code === 101) return false;
      throw error;
    }
    if (!result?.authKey) return false;
    writeAuth({ authKey: result.authKey, email: null }, pid);
    const user = await api("getUser", {}, pid).catch(() => null);
    writeAuth({ authKey: result.authKey, email: user?.email || null }, pid);
    libraries.delete(pid);
    return true;
  },

  disconnect(pid = profileId()) {
    const auth = readAuth(pid);
    writeAuth(null, pid);
    libraries.delete(pid);
    if (auth) {
      void call(API_URL + "logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ authKey: auth.authKey })
      }).catch(() => {});
    }
  },

  hasLoadedRemoteProgress(pid = profileId()) {
    return Boolean(libraries.get(pid)?.fetchedAt);
  },

  refresh({ force = true } = {}) {
    return loadLibrary({ force });
  },

  async getProgressSnapshot() {
    const items = this.connected() ? await loadLibrary().catch(() => new Map()) : new Map();
    const playbackItems = [...items.values()].map(stremioLibraryItemToProgress).filter(Boolean);
    return { historyItems: [], playbackItems, watchedShowSeedItems: [] };
  },

  async pushProgress(progress, { force = false } = {}) {
    if (!this.connected() || !progress?.contentId) return false;
    if (!/^tt\d+/.test(String(progress.contentId))) return false;
    const pid = profileId();
    const key = `${pid}:${progress.contentId}`;
    const durationMs = Number(progress.durationMs || 0);
    const completed = durationMs > 0 && Number(progress.positionMs || 0) / durationMs >= CREDITS_THRESHOLD_COEF;
    if (!force && !completed && Date.now() - (lastPushAt.get(key) || 0) < PUSH_INTERVAL_MS) {
      return false;
    }
    lastPushAt.set(key, Date.now());
    // Serialized so a pause push cannot read the item before a checkpoint push stored it.
    const task = pushQueue.then(async () => {
      const items = await loadLibrary();
      const next = applyStremioProgress(items.get(progress.contentId), progress);
      await api("datastorePut", { collection: "libraryItem", changes: [next] }, pid);
      items.set(next._id, next);
      return true;
    });
    pushQueue = task.catch(() => {});
    return task;
  },

  // The user's Stremio Library: items they added (not removed), newest change first.
  async getLibraryItems() {
    if (!this.connected()) return [];
    const items = await loadLibrary();
    return [...items.values()]
      .filter((row) => !row.removed && (row.type === "movie" || row.type === "series"))
      .sort((left, right) => (Date.parse(right._mtime) || 0) - (Date.parse(left._mtime) || 0))
      .map((row) => ({
        contentId: row._id,
        contentType: row.type,
        title: row.name,
        poster: row.poster || null,
        posterShape: row.posterShape || "poster",
        updatedAt: Date.parse(row._mtime) || 0
      }));
  },

  async isInLibrary(contentId) {
    if (!this.connected() || !contentId) return false;
    const row = (await loadLibrary()).get(String(contentId));
    return Boolean(row && !row.removed);
  },

  async setInLibrary(item, saved) {
    const pid = profileId();
    const items = await loadLibrary();
    const now = nowIso();
    const base = items.get(item.contentId) || newLibraryItem(item, now);
    const next = { ...base, removed: !saved, temp: false, _mtime: now };
    await api("datastorePut", { collection: "libraryItem", changes: [next] }, pid);
    items.set(next._id, next);
  },

  async getAddonUrls() {
    const result = await api("addonCollectionGet", { update: true });
    return (result?.addons || [])
      .map((addon) => addon?.transportUrl)
      .filter((url) => typeof url === "string" && /^https?:\/\//.test(url));
  },

  async importAddons(addonRepository) {
    let added = 0;
    for (const url of await this.getAddonUrls()) {
      if (await addonRepository.addAddon(url)) added += 1;
    }
    return added;
  }
};

registerSessionTeardownHandler(() => libraries.clear());
