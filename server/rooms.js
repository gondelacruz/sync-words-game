// ---------------------------------------------------------------------------
// SYNC — room state machine. One host (the laptop), up to six phones.
// Phases: lobby -> armed -> countdown -> live -> reveal -> armed
//
// A round is one WHOLE track, start to finish. The live meter scores you
// against the lyrics that have gone past so far, so the race stays honest
// at every moment; the final score is against the entire song.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { findLyrics, buildTimeline, targetSoFar } from './lyrics.js';
import { score, missed, tokenize } from './scoring.js';
import { detectLanguage } from './lang.js';

const tokensOf = (t) => tokenize(t);

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0, no I/1
const MAX_PLAYERS = 6;
const COUNTDOWN_MS = 3400;
const REVEAL_HOLD_MS = 900;
const IDLE_ROOM_MS = 1000 * 60 * 90;
const MAX_ROUND_MS = 1000 * 60 * 12;   // no track runs a round longer than this
const FALLBACK_ROUND_MS = 1000 * 60 * 3;  // used only when nothing knows the runtime

const rooms = new Map();

const now = () => Date.now();

function makeCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)]).join('');
  } while (rooms.has(code));
  return code;
}

export function createRoom() {
  const room = {
    code: makeCode(),
    createdAt: now(),
    touchedAt: now(),
    phase: 'lobby',
    hostSocket: null,
    players: new Map(),
    settings: { winAt: 3, lang: 'en-US' },
    roundMs: 0,                 // set from the track when one is armed
    track: null,
    lyrics: null,
    round: null,
    lastResult: null,
    roundNo: 0,
    timers: [],
    ticker: null,
  };
  rooms.set(room.code, room);
  return room;
}

export const getRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
  if (room.ticker) { clearInterval(room.ticker); room.ticker = null; }
}

function later(room, ms, fn) {
  room.timers.push(setTimeout(fn, ms));
}

export function addPlayer(room, { name, playerId }) {
  const existing = playerId && room.players.get(playerId);
  if (existing) {
    existing.connected = true;
    if (name) existing.name = name.slice(0, 14);
    return existing;
  }
  if (room.players.size >= MAX_PLAYERS) return null;
  const id = playerId || randomUUID();
  const slot = room.players.size;
  const player = {
    id,
    slot,
    name: (name || `P${slot + 1}`).slice(0, 14),
    points: 0,
    connected: true,
    micOk: false,
    engine: null,
    ready: false,
    heard: '',
    live: { percent: 0, hits: 0, total: 0, phrase: 0, matched: [] },
    socket: null,
  };
  room.players.set(id, player);
  return player;
}

/** Attach a Spotify track and go find its synced lyrics. */
export async function armTrack(room, track) {
  room.track = track;
  room.lyrics = null;
  room.round = null;
  room.lastResult = null;
  room.phase = 'loading';

  const lyrics = await findLyrics({
    title: track.name,
    artist: track.artist,
    album: track.album,
    durationMs: track.durationMs,
  });

  if (room.track !== track) return { ok: false, reason: 'superseded' };

  if (!lyrics) {
    room.phase = 'lobby';
    room.track = null;
    return { ok: false, reason: 'no-synced-lyrics' };
  }

  room.lyrics = lyrics;
  // Sing in whatever language the song is in: no setting for the host to get wrong.
  room.settings.lang = detectLanguage(lyrics.lines.map((l) => l.text).join('\n')).bcp47;
  // The round is the track, top to tail. Fall back to the lyric sheet's own
  // duration when the source did not give us one (manual mode), and cap it so
  // a bad number cannot leave a room stuck live forever.
  const runtime = track.durationMs || lyrics.durationMs || 0;
  room.roundMs = runtime > 0 ? Math.min(MAX_ROUND_MS, runtime) : FALLBACK_ROUND_MS;
  room.phase = 'armed';
  return { ok: true };
}

export function beginCountdown(room) {
  if (!room.lyrics || room.players.size < 1) return false;
  clearTimers(room);
  room.roundNo += 1;
  room.lastResult = null;
  for (const p of room.players.values()) {
    p.heard = '';
    p.clips = new Map();
    p.live = { percent: 0, hits: 0, total: 0, phrase: 0, matched: [] };
  }
  room.round = {
    no: room.roundNo,
    fromMs: 0,
    timeline: null,
    target: [],
    startsAt: now() + COUNTDOWN_MS,
    startedAt: null,
    endsAt: null,
  };
  room.phase = 'countdown';
  return true;
}

/**
 * The host's player reported real playback position — lock the round to what
 * will actually come out of the speakers, and run until the track ends.
 */
export function lockWindow(room, positionMs, onEnd) {
  if (room.phase !== 'countdown' && room.phase !== 'live') return;
  const from = Number.isFinite(positionMs) && positionMs > 0 ? positionMs : 0;
  const remaining = Math.max(10000, room.roundMs - from);
  room.round.fromMs = from;
  room.round.timeline = buildTimeline(room.lyrics.lines, from, from + remaining);
  room.round.target = room.round.timeline.all;
  room.round.startedAt = now();
  room.round.endsAt = now() + remaining;
  room.phase = 'live';
  clearTimers(room);
  later(room, remaining, () => onEnd(room));
}

/** Where the needle is right now, in track time. */
function playhead(room) {
  return room.round.fromMs + (now() - room.round.startedAt);
}

/**
 * One transcribed clip from a phone (Groq path). Clips can finish out of order,
 * so they are kept by sequence number and re-joined in order every time.
 */
export function hearClip(room, player, roundNo, seq, text) {
  if (room.phase !== 'live' || roundNo !== room.roundNo) return false;
  if (!player.clips) player.clips = new Map();
  player.clips.set(seq, String(text || ''));
  const joined = [...player.clips.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join(' ');
  return hear(room, player, joined);
}

export function hear(room, player, text) {
  if (room.phase !== 'live') return false;
  player.heard = String(text || '').slice(0, 24000);
  rescoreAll(room);
  return true;
}

/**
 * Re-score everyone against the same playhead.
 *
 * Two reasons this is not per-player: the denominator must match across the
 * screen (two lanes reading "13/13" and "5/17" at the same instant is just
 * confusing), and a player who has gone quiet should watch their percentage
 * slide as the song moves on without them.
 */
export function rescoreAll(room) {
  if (room.phase !== 'live') return;
  // Score against what has actually played, not the whole song — otherwise the
  // meter would crawl for four minutes and nobody could tell who was winning.
  const due = targetSoFar(room.round.timeline, playhead(room));
  for (const p of room.players.values()) {
    p.live = score(due, tokensOf(p.heard), { phraseFloor: p.live.phrase });
  }
}

/** Drive the live meters once a second so they move with the music. */
export function startTicker(room, onTick) {
  if (room.ticker) clearInterval(room.ticker);
  room.ticker = setInterval(() => {
    if (room.phase !== 'live') { clearInterval(room.ticker); room.ticker = null; return; }
    rescoreAll(room);
    onTick(room);
  }, 1000);
}


export function finishRound(room) {
  clearTimers(room);
  room.phase = 'reveal';

  const target = room.round?.target ?? [];
  const rows = [...room.players.values()].map((p) => {
    const s = score(target, tokensOf(p.heard), { exact: true });
    return { id: p.id, name: p.name, slot: p.slot, ...s, heard: p.heard };
  });
  rows.sort((a, b) => b.percent - a.percent || b.phrase - a.phrase);

  const top = rows[0];
  const tie = rows.length > 1 && rows[1].percent === top?.percent && rows[1].phrase === top?.phrase;
  const winner = !top || top.percent === 0 || tie ? null : top;
  if (winner) {
    const p = room.players.get(winner.id);
    if (p) p.points += 1;
  }

  const champion = [...room.players.values()].find((p) => p.points >= room.settings.winAt) || null;

  room.lastResult = {
    roundNo: room.round?.no ?? 0,
    rows,
    winnerId: winner?.id ?? null,
    tie,
    target,
    missedBy: Object.fromEntries(rows.map((r) => [r.id, missed(target, tokensOf(r.heard)).slice(0, 24)])),
    championId: champion?.id ?? null,
    // The full sheet is long, so the reveal shows the opening and the tail.
    lineText: (room.round?.timeline?.lines ?? []).map((l) => l.text),
  };
  if (champion) room.phase = 'champion';
  return room.lastResult;
}

export function resetForNext(room) {
  clearTimers(room);
  room.round = null;
  room.lastResult = null;
  room.track = null;
  room.lyrics = null;
  room.roundMs = 0;
  room.phase = 'lobby';
}

export function resetMatch(room) {
  resetForNext(room);
  room.roundNo = 0;
  for (const p of room.players.values()) {
    p.points = 0;
    p.heard = '';
    p.live = { percent: 0, hits: 0, total: 0, phrase: 0, matched: [] };
  }
}

/** What both screens render from. Never leaks sockets or full lyric sheets. */
export function snapshot(room) {
  return {
    code: room.code,
    phase: room.phase,
    settings: room.settings,
    roundNo: room.roundNo,
    track: room.track,
    hasLyrics: Boolean(room.lyrics),
    roundMs: room.roundMs ?? 0,
    lineCount: room.lyrics?.lines.length ?? 0,
    countdownStartsAt: room.round?.startsAt ?? null,
    endsAt: room.round?.endsAt ?? null,
    targetCount: room.round?.target.length ?? 0,
    players: [...room.players.values()].map((p) => ({
      id: p.id,
      slot: p.slot,
      name: p.name,
      points: p.points,
      connected: p.connected,
      micOk: p.micOk,
      engine: p.engine,
      ready: p.ready,
      percent: p.live.percent,
      hits: p.live.hits,
      total: p.live.total,
      phrase: p.live.phrase,
    })),
    result: room.lastResult,
    serverNow: now(),
  };
}

export const REVEAL_HOLD = REVEAL_HOLD_MS;
export const COUNTDOWN = COUNTDOWN_MS;

setInterval(() => {
  const cutoff = now() - IDLE_ROOM_MS;
  for (const [code, room] of rooms) {
    if (room.touchedAt < cutoff) {
      clearTimers(room);
      rooms.delete(code);
    }
  }
}, 60000).unref?.();
