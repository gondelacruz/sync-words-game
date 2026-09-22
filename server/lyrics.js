// ---------------------------------------------------------------------------
// SYNG — lyrics via LRCLIB (https://lrclib.net), a free, key-less, community
// database of time-synced lyrics. We only ever want the *synced* kind: knowing
// which words are playing right now is the whole game.
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { tokenize } from './scoring.js';

const UA = 'sync-words/1.0.0 (https://github.com/sync-words)';
const BASE = 'https://lrclib.net/api';
const cache = new Map();

/** For comparing titles: accents, brackets and punctuation removed. */
const simplify = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();          // key -> parsed lyrics (or null)
const TTL = 1000 * 60 * 60 * 6;

async function get(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, v);
  }
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(8000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error('lrclib ' + res.status);
  return res.json();
}

/** Parse an LRC blob into [{ ms, text }], sorted, blank lines dropped. */
export function parseLrc(lrc) {
  const out = [];
  for (const raw of String(lrc || '').split('\n')) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    if (!text) continue;                       // instrumental markers
    for (const s of stamps) {
      const frac = s[3] ? Number(('0.' + s[3])) : 0;
      out.push({ ms: (Number(s[1]) * 60 + Number(s[2]) + frac) * 1000, text });
    }
  }
  return out.sort((a, b) => a.ms - b.ms);
}

function pack(record) {
  if (!record || record.instrumental || !record.syncedLyrics) return null;
  const lines = parseLrc(record.syncedLyrics);
  if (lines.length < 4) return null;
  return {
    source: 'lrclib',
    id: record.id,
    trackName: record.trackName,
    artistName: record.artistName,
    durationMs: Math.round((record.duration || 0) * 1000),
    lines,
  };
}

/**
 * Find synced lyrics for a Spotify track. Tries the exact signature match
 * first (best quality), then falls back to a fuzzy search.
 */
export async function findLyrics({ title, artist, album, durationMs }) {
  // Offline escape hatch used by scripts/simulate.js — point it at an .lrc file
  // and every track resolves to it. Never set in production.
  if (process.env.SYNC_LYRICS_FIXTURE) {
    const lines = parseLrc(readFileSync(process.env.SYNC_LYRICS_FIXTURE, 'utf8'));
    return lines.length ? { source: 'fixture', id: 0, trackName: title, artistName: artist, durationMs: durationMs || 0, lines } : null;
  }

  const key = [title, artist, Math.round((durationMs || 0) / 1000)].join('::').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  let value = null;
  const target = Math.round((durationMs || 0) / 1000);

  // The exact lookup needs a duration; Random-mode songs come without one.
  if (target > 0) {
    try {
      value = pack(await get('/get', {
        track_name: title,
        artist_name: artist,
        album_name: album,
        duration: target,
      }));
    } catch { /* fall through to search */ }
  }

  if (!value) {
    try {
      const results = (await get('/search', { track_name: title, artist_name: artist })) || [];
      let ranked = results.filter((r) => r.syncedLyrics && !r.instrumental);
      if (target > 0) {
        ranked.sort((a, b) => Math.abs((a.duration || 0) - target) - Math.abs((b.duration || 0) - target));
      } else {
        // No duration to aim for: keep entries that really are this song (not a
        // remix or a live cut with a longer name), then take the median length,
        // which is the studio version far more often than the extremes.
        const want = simplify(title);
        const exact = ranked.filter((r) => simplify(r.trackName) === want);
        if (exact.length) ranked = exact;
        ranked.sort((a, b) => (a.duration || 0) - (b.duration || 0));
        const mid = Math.floor((ranked.length - 1) / 2);
        ranked = [ranked[mid], ...ranked.slice(0, mid), ...ranked.slice(mid + 1)].filter(Boolean);
      }
      for (const r of ranked) {
        value = pack(r);
        if (value) break;
      }
    } catch { /* give up quietly */ }
  }

  cache.set(key, { at: Date.now(), value });
  return value;
}

/** Lyric lines whose timestamp falls inside a playback window. */
export function linesIn(lines, fromMs, toMs) {
  // 400ms of grace at the front: singers come in a hair before the timestamp.
  return lines.filter((l) => l.ms >= fromMs - 400 && l.ms < toMs);
}

/** Tokens a player has to hit during a window. */
export function targetFor(lines, fromMs, toMs) {
  return tokenize(linesIn(lines, fromMs, toMs).map((l) => l.text).join(' '));
}

/**
 * Precompute, for a whole-track round, the tokens due by each lyric line.
 * A full song is a few hundred tokens, so building the prefixes once and
 * slicing them beats re-tokenising the sheet on every microphone update.
 *
 * Returns { times, upTo, all } where upTo[i] is the token count due once
 * line i has passed, and all is every token in the window.
 */
export function buildTimeline(lines, fromMs, toMs) {
  const inWindow = linesIn(lines, fromMs, toMs);
  const times = [];
  const upTo = [];
  const all = [];
  for (const line of inWindow) {
    for (const tok of tokenize(line.text)) all.push(tok);
    times.push(line.ms);
    upTo.push(all.length);
  }
  return { times, upTo, all, lines: inWindow };
}

/** The tokens that have actually been sung past, at playback position `ms`. */
export function targetSoFar(timeline, ms) {
  const { times, upTo, all } = timeline;
  let lo = 0, hi = times.length - 1, idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid] - 400 <= ms) { idx = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return idx < 0 ? [] : all.slice(0, upTo[idx]);
}


/* --- song search for the game master (free, no key) -------------------------- */

const searchCache = new Map();

/**
 * Free-text song search against LRCLIB. Only songs that HAVE time-synced lyrics
 * come back, so anything the host clicks is playable. Duplicates (the same song
 * on five albums) collapse into one row with the most typical length.
 */
export async function searchSongs(q) {
  const query = String(q || '').replace(/\s+/g, ' ').trim().slice(0, 120);
  if (query.length < 2) return [];
  if (process.env.SYNC_LYRICS_FIXTURE) {
    return [
      { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera', durationMs: 14000 },
      { title: query, artist: 'Test Artist', album: '', durationMs: 14000 },
    ];
  }
  const k = query.toLowerCase();
  const hit = searchCache.get(k);
  if (hit && Date.now() - hit.at < TTL) return hit.value;

  const results = (await get('/search', { q: query })) || [];
  const groups = new Map();
  for (const r of results) {
    if (!r.syncedLyrics || r.instrumental) continue;
    const g = `${simplify(r.artistName)}|${simplify(r.trackName)}`;
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(r);
  }
  const value = [...groups.values()].slice(0, 12).map((rows) => {
    rows.sort((a, b) => (a.duration || 0) - (b.duration || 0));
    const r = rows[Math.floor((rows.length - 1) / 2)];
    return { title: r.trackName, artist: r.artistName, album: r.albumName || '', durationMs: Math.round((r.duration || 0) * 1000) };
  });
  searchCache.set(k, { at: Date.now(), value });
  if (searchCache.size > 500) searchCache.delete(searchCache.keys().next().value);
  return value;
}
