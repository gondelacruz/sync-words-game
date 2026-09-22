// ---------------------------------------------------------------------------
// SYNG — finding the song on YouTube (the default music source).
//
// The host screen plays the song in an embedded YouTube player. The server
// finds the right video with the YouTube Data API and remembers every match in
// server/youtube-ids.json, so a song is only ever searched once.
//
// QUOTA (Sept 2026): one Google Cloud project gets 100 search.list calls per
// day, shared by EVERYONE using this server (it is per API key/project, not per
// player), resetting at midnight Pacific time. videos.list (durations) comes out
// of a separate 10,000-unit pool and costs 1 unit, so it is effectively free.
// When searches run out the host can still paste a YouTube link by hand.
//
// Set YOUTUBE_API_KEY in Render's Environment tab. Without it everything still
// works, but the host pastes a link for each song.
// ---------------------------------------------------------------------------

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const BASE = process.env.YOUTUBE_API_BASE || 'https://www.googleapis.com/youtube/v3';
const CACHE_FILE = process.env.YOUTUBE_CACHE_FILE || join(here, 'youtube-ids.json');
const DAILY_SEARCHES = Number(process.env.YOUTUBE_DAILY_SEARCHES || 100);
const KEEP = 5;                                     // candidates kept per song

const key = () => process.env.YOUTUBE_API_KEY || '';
export const ytEnabled = () => Boolean(key());

/** Accents, brackets and punctuation removed, for comparing titles. */
export const simplify = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, ' ').trim();
const songKey = (artist, title) => `${simplify(artist)}|${simplify(title)}`;

/* --- the remembered matches ------------------------------------------------ */

let cache = {};
try { if (existsSync(CACHE_FILE)) cache = JSON.parse(readFileSync(CACHE_FILE, 'utf8')) || {}; } catch { cache = {}; }
let saveTimer = 0;
function remember(k, videos) {
  cache[k] = { videos, at: new Date().toISOString().slice(0, 10) };
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 1) + '\n'); } catch (e) { console.warn('[youtube] could not save cache', e.message); }
  }, 1500);
  saveTimer.unref?.();
}
export const cachedCount = () => Object.keys(cache).length;

/* --- daily search budget ------------------------------------------------------ */

// Quota days run on Pacific time. We count our own searches so we stop before
// Google starts refusing; a restart forgets the count, but Google's own
// "quotaExceeded" answer is handled too.
const ptDay = (d = new Date()) => d.toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });
let budget = { day: ptDay(), used: 0, exhausted: false };
function spend() {
  if (budget.day !== ptDay()) budget = { day: ptDay(), used: 0, exhausted: false };
  if (budget.exhausted || budget.used >= DAILY_SEARCHES) return false;
  budget.used += 1;
  return true;
}

/** Epoch ms of the next midnight in Los Angeles, when the quota refills. */
export function quotaResetsAt(now = Date.now()) {
  const d = new Date(now);
  const asPT = new Date(d.toLocaleString('en-US', { timeZone: 'America/Los_Angeles' }));
  const asUTC = new Date(d.toLocaleString('en-US', { timeZone: 'UTC' }));
  const offset = asPT - asUTC;                      // PT minus UTC, e.g. -7h
  const ptNow = new Date(now + offset);
  const nextMidnight = Date.UTC(ptNow.getUTCFullYear(), ptNow.getUTCMonth(), ptNow.getUTCDate() + 1);
  return nextMidnight - offset;
}

export function quotaStatus() {
  if (budget.day !== ptDay()) budget = { day: ptDay(), used: 0, exhausted: false };
  return {
    enabled: ytEnabled(),
    searchesLeft: budget.exhausted ? 0 : Math.max(0, DAILY_SEARCHES - budget.used),
    perDay: DAILY_SEARCHES,
    resetsAt: quotaResetsAt(),
    remembered: cachedCount(),
  };
}

/* --- API ------------------------------------------------------------------------ */

async function api(path, params) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries({ ...params, key: key() })) url.searchParams.set(k, v);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || '';
    const err = new Error(`youtube ${res.status} ${reason}`);
    err.quota = res.status === 403 && /quota|dailyLimit|rateLimit/i.test(reason);
    throw err;
  }
  return body;
}

/** "PT3M34S" -> 214000 */
export function isoToMs(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(String(iso || ''));
  if (!m) return 0;
  const [, d, h, mi, s] = m.map((x) => Number(x) || 0);
  return (((d * 24 + h) * 60 + mi) * 60 + s) * 1000;
}

/** Durations, embeddability and titles for up to 50 ids. Costs 1 unit. */
async function details(ids) {
  if (!ids.length) return [];
  const body = await api('/videos', { part: 'snippet,contentDetails,status', id: ids.join(','), maxResults: 50 });
  return (body.items || []).map((v) => ({
    id: v.id,
    title: v.snippet?.title || '',
    channel: v.snippet?.channelTitle || '',
    durationMs: isoToMs(v.contentDetails?.duration),
    thumb: v.snippet?.thumbnails?.medium?.url || v.snippet?.thumbnails?.default?.url || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`,
    embeddable: v.status?.embeddable !== false,
  }));
}

// Versions that would not line up with the studio lyrics (or would show them).
const BAD = /\b(live|en vivo|ao vivo|en directo|concert|cover|karaoke|instrumental|remix|sped ?up|slowed|nightcore|8d|reverb|reaction|tutorial|lesson|piano|guitar|acoustic|ac[uú]stic|bass boosted|hours?|mashup|parody|tribute|medley|extended|megamix|short)\b/i;
const LYRIC = /\b(lyrics?|letra|paroles|testo|songtext|lyric video)\b/i;

/**
 * Lower is better. The studio recording matters most — the lyric timestamps
 * come from it — so duration is weighted heavily and YouTube's auto-generated
 * "Artist - Topic" uploads (the exact album audio) get a bonus.
 */
export function cost(v, want) {
  const title = v.title.toLowerCase();
  let c = 0;
  if (want.durationMs && v.durationMs) c += Math.min(150, Math.abs(v.durationMs - want.durationMs) / 1000) * 3;
  else c += 40;
  const topic = / - topic$/i.test(v.channel);
  if (topic) c -= 30;
  if (/official audio|\(audio\)|\[audio\]|audio oficial|audio officiel/.test(title)) c -= 15;
  const allowed = simplify(want.title);                  // "Live and Let Die" is fine
  const badHit = title.match(BAD);
  if (badHit && !` ${allowed} `.includes(` ${simplify(badHit[0])} `)) c += 70;
  if (LYRIC.test(title)) c += 25;                       // lyrics on screen = spoilers
  if (!simplify(v.title).includes(allowed.split(' ').slice(0, 3).join(' '))) c += 35;
  const artist = simplify(want.artist).split(' ')[0] || '';
  if (artist && !simplify(v.title + ' ' + v.channel).includes(artist)) c += 20;
  if (!v.embeddable) c += 1000;
  return c;
}

const blank = (reason) => ({ ok: false, reason, videos: [] });

/**
 * Best YouTube matches for a song, best first.
 * @returns {{ok:boolean, reason?:'nokey'|'quota'|'none'|'error', videos:Array, cached?:boolean}}
 */
export async function findVideos({ title, artist, durationMs }) {
  const k = songKey(artist, title);
  const hit = cache[k];
  if (hit?.videos?.length) return { ok: true, cached: true, videos: hit.videos };
  if (!ytEnabled()) return blank('nokey');
  if (!spend()) return blank('quota');

  try {
    const q = `${artist} ${title}`.trim();
    const found = await api('/search', {
      part: 'snippet', type: 'video', videoEmbeddable: 'true', maxResults: 15, q, safeSearch: 'none',
    });
    const ids = (found.items || []).map((i) => i.id?.videoId).filter(Boolean);
    if (!ids.length) return blank('none');
    const vids = (await details(ids)).filter((v) => v.durationMs > 0 && v.embeddable);
    const want = { title, artist, durationMs };
    vids.sort((a, b) => cost(a, want) - cost(b, want));
    const videos = vids.slice(0, KEEP).map(({ embeddable, ...v }) => v);
    if (!videos.length) return blank('none');
    remember(k, videos);
    return { ok: true, videos };
  } catch (e) {
    if (e.quota) { budget.exhausted = true; return blank('quota'); }
    console.warn('[youtube]', e.message);
    return blank('error');
  }
}

/** The host pasted a link: fill in the title/length when we can (1 unit). */
export async function videoInfo(id) {
  const fallback = { id, title: '', channel: '', durationMs: 0, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
  if (!ytEnabled()) return fallback;
  try {
    const [v] = await details([id]);
    if (!v) return null;                            // no such video
    const { embeddable, ...rest } = v;
    return { ...rest, embeddable };
  } catch { return fallback; }
}

/** Remember a video the host chose by hand, so next time it is automatic. */
export function rememberChoice({ title, artist }, video, others = []) {
  const k = songKey(artist, title);
  const rest = others.filter((v) => v.id !== video.id);
  remember(k, [video, ...rest].slice(0, KEEP));
}

/** Anything a person might paste: a watch URL, youtu.be, shorts, music.youtube, or a bare id. */
export function parseVideoId(input) {
  const s = String(input || '').trim();
  if (/^[\w-]{11}$/.test(s)) return s;
  try {
    const u = new URL(s.startsWith('http') ? s : 'https://' + s);
    if (/(^|\.)youtu\.be$/.test(u.hostname)) return u.pathname.slice(1, 12) || null;
    if (/(^|\.)youtube(-nocookie)?\.com$/.test(u.hostname)) {
      const v = u.searchParams.get('v');
      if (v && /^[\w-]{11}$/.test(v)) return v;
      const m = u.pathname.match(/\/(?:embed|shorts|live|v)\/([\w-]{11})/);
      if (m) return m[1];
    }
  } catch { /* not a URL */ }
  return null;
}
