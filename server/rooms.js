// ---------------------------------------------------------------------------
// SYNG — room state machine. One host (the laptop), up to ten teams. Each team
// is one phone with a list of members; one member per team sings each round.
//
//   setup ─start─▶ choosing (random mode: a team picks 1 of 3 songs on its phone)
//                  pick     (game master: the host searches a song)
//          ─▶ loading ─▶ singers (game master picks who sings; random draws)
//          ─▶ armed ─▶ countdown ─▶ live ─▶ scoring ─▶ reveal
//          ─▶ next round … ─▶ final ─▶ setup (same teams)
//
// A round is one WHOLE track. Phones record ~15s clips; "scoring" waits for the
// last clip of every phone before the result, so the tail of the song counts.
// ---------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { findLyrics, buildTimeline, targetSoFar } from './lyrics.js';
import { score, tokenize } from './scoring.js';
import { detectLanguage } from './lang.js';
import { pool } from './songs.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // no O/0, no I/1
export const MAX_TEAMS = 10;
export const MAX_MEMBERS = 30;
export const MAX_ROUNDS = 30;
const COUNTDOWN_MS = 3400;
const SCORING_WAIT_MS = 20000;       // longest we wait for the last clips
const IDLE_ROOM_MS = 1000 * 60 * 120;
const MAX_ROUND_MS = 1000 * 60 * 12;
const FALLBACK_ROUND_MS = 1000 * 60 * 3;
const OPTIONS = 3;
const CLIP_MIN_MS = 15000;           // phones record self-contained clips this long…
const GROQ_PER_MINUTE = 18;          // …or longer, so all phones together stay under Groq's 20/min

// Where the music comes from. 'youtube' is the default; 'spotify' is kept for
// rollback (see README → "Revert to Spotify"); 'manual' = the host plays it.
export const MUSIC_SOURCES = ['youtube', 'spotify', 'manual'];

const LANG_BCP47 = { en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', it: 'it-IT', de: 'de-DE' };

const rooms = new Map();
const now = () => Date.now();
const clean = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

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
    phase: 'setup',
    hostSocket: null,
    music: 'youtube',
    teams: new Map(),
    settings: { mode: 'random', rounds: 5, langs: ['en'], lang: 'en-US' },
    roundNo: 0,
    chooserId: null,
    options: null,          // random mode: the three songs on offer
    optionsError: null,
    optionsToken: 0,
    song: null,             // random mode: the chosen jukebox entry
    track: null,            // what the host plays: { name, artist, art, durationMs, video, videos, uri (Spotify) }
    lyrics: null,
    roundMs: 0,
    singers: {},            // teamId -> member name
    round: null,
    lastResult: null,
    played: new Set(),      // jukebox ids already sung this game
    history: [],            // [{ roundNo, title, artist, winnerId }]
    timers: [],
    ticker: null,
  };
  rooms.set(room.code, room);
  return room;
}

export const getRoom = (code) => rooms.get(String(code || '').toUpperCase().trim());
export const teamList = (room) => [...room.teams.values()].sort((a, b) => a.slot - b.slot);

function clearTimers(room) {
  for (const t of room.timers) clearTimeout(t);
  room.timers = [];
  if (room.ticker) { clearInterval(room.ticker); room.ticker = null; }
}
const later = (room, ms, fn) => room.timers.push(setTimeout(fn, ms));
const blankLive = () => ({ percent: 0, hits: 0, total: 0, phrase: 0, matched: [] });

/* --- teams ---------------------------------------------------------------- */

function cleanMembers(list) {
  const seen = new Set();
  const out = [];
  for (const m of Array.isArray(list) ? list : []) {
    const n = clean(m, 20);
    if (!n || seen.has(n.toLowerCase())) continue;
    seen.add(n.toLowerCase());
    out.push(n);
    if (out.length >= MAX_MEMBERS) break;
  }
  return out;
}

/** Join or re-join. New teams are only accepted before the game starts. */
export function addTeam(room, { name, members, teamId }) {
  const existing = teamId && room.teams.get(teamId);
  if (existing) {
    existing.connected = true;
    if (room.phase === 'setup') {
      if (name) existing.name = clean(name, 18);
      const m = cleanMembers(members);
      if (m.length) existing.members = m;
    }
    return { team: existing };
  }
  if (room.phase !== 'setup') return { error: 'game-running' };
  if (room.teams.size >= MAX_TEAMS) return { error: 'room-full' };
  const used = new Set([...room.teams.values()].map((t) => t.slot));
  let slot = 0;
  while (used.has(slot)) slot++;
  const team = {
    id: teamId || randomUUID(),
    slot,
    name: clean(name, 18) || `Team ${slot + 1}`,
    members: cleanMembers(members),
    points: 0,
    lastGain: 0,
    connected: true,
    micOk: false,
    engine: null,
    heard: '',
    clips: new Map(),
    inflight: 0,
    finalIn: false,
    clipSeen: false,
    sung: new Set(),
    live: blankLive(),
    socket: null,
  };
  if (!team.members.length) team.members = [team.name];
  room.teams.set(team.id, team);
  return { team };
}

export function setTeamInfo(room, team, { name, members }) {
  if (room.phase !== 'setup') return false;
  if (name !== undefined) team.name = clean(name, 18) || team.name;
  if (members !== undefined) {
    const m = cleanMembers(members);
    if (m.length) team.members = m;
  }
  return true;
}

export function removeTeam(room, teamId) {
  if (room.phase !== 'setup') return null;
  const team = room.teams.get(teamId);
  if (team) room.teams.delete(teamId);
  return team || null;
}

/* --- game flow ------------------------------------------------------------ */

export function startGame(room, { mode, rounds, langs }) {
  if (room.phase !== 'setup' || room.teams.size < 1) return false;
  const s = room.settings;
  s.mode = mode === 'master' ? 'master' : 'random';
  s.rounds = Math.min(MAX_ROUNDS, Math.max(1, Math.round(Number(rounds) || 5)));
  const ok = (Array.isArray(langs) ? langs : []).filter((l) => LANG_BCP47[l]);
  s.langs = ok.length ? ok : ['en'];
  room.roundNo = 0;
  room.played = new Set();
  room.history = [];
  for (const t of room.teams.values()) { t.points = 0; t.lastGain = 0; t.sung = new Set(); }
  return true;
}

/** Move to the next round's song selection. Returns a promise in random mode. */
export function nextRound(room) {
  clearTimers(room);
  room.roundNo += 1;
  room.track = null;
  room.song = null;
  room.lyrics = null;
  room.round = null;
  room.lastResult = null;
  room.singers = {};
  room.roundMs = 0;
  for (const t of room.teams.values()) t.lastGain = 0;
  return beginSelection(room);
}

/** (Re)open song selection for the current round. */
export function beginSelection(room) {
  room.track = null;
  room.song = null;
  room.lyrics = null;
  room.singers = {};
  if (room.settings.mode === 'master') {
    room.phase = 'pick';
    room.options = null;
    return Promise.resolve();
  }
  const order = teamList(room);
  room.chooserId = order.length ? order[(room.roundNo - 1) % order.length].id : null;
  room.phase = 'choosing';
  return dealOptions(room);
}

/** Draw three random songs that really have synced lyrics. */
export async function dealOptions(room) {
  const token = ++room.optionsToken;
  room.options = null;
  room.optionsError = null;

  let candidates = shuffle(pool(room.settings.langs, room.played));
  if (candidates.length < OPTIONS) candidates = shuffle(pool(room.settings.langs));   // jukebox ran dry: allow repeats
  const found = [];
  while (found.length < OPTIONS && candidates.length) {
    const batch = candidates.splice(0, 5);
    const checked = await Promise.all(batch.map(async (song) => {
      const lyrics = await findLyrics({ title: song.title, artist: song.artist }).catch(() => null);
      return lyrics ? { song, lyrics } : null;
    }));
    if (token !== room.optionsToken) return;           // superseded while we waited
    for (const c of checked) if (c && found.length < OPTIONS) found.push(c);
  }
  if (token !== room.optionsToken) return;
  if (!found.length) {
    room.optionsError = 'Could not reach the lyrics library. Try again in a moment.';
    return;
  }
  room.options = found.map(({ song, lyrics }) => ({
    ...song,
    durationMs: lyrics.durationMs,
    lines: lyrics.lines.length,
    _lyrics: lyrics,
  }));
}

/** A team (or the host, on its behalf) picks one of the three. */
export function chooseOption(room, idx) {
  if (room.phase !== 'choosing' || !room.options) return null;
  const opt = room.options[Number(idx)];
  if (!opt) return null;
  room.song = { id: opt.id, title: opt.title, artist: opt.artist, year: opt.year, lang: opt.lang };
  room.track = {
    id: opt.id, uri: null, name: opt.title, artist: opt.artist, album: '', art: '',
    durationMs: opt.durationMs || 0, resolving: room.music !== 'manual',
    video: null, videos: [], videoIdx: 0, videoError: null,
  };
  armWithLyrics(room, opt._lyrics, LANG_BCP47[opt.lang]);
  room.options = null;
  return room.song;
}

/** Game master picked a track from search: go find its lyrics. */
export async function armTrack(room, track) {
  if (room.phase !== 'pick' && room.phase !== 'loading') return { ok: false, reason: 'wrong-phase' };
  Object.assign(track, { video: null, videos: [], videoIdx: 0, videoError: null, resolving: room.music === 'youtube' });
  room.track = track;
  room.lyrics = null;
  room.phase = 'loading';
  const lyrics = await findLyrics({
    title: track.name, artist: track.artist, album: track.album, durationMs: track.durationMs,
  });
  if (room.track !== track) return { ok: false, reason: 'superseded' };
  if (!lyrics) {
    room.phase = 'pick';
    room.track = null;
    return { ok: false, reason: 'no-synced-lyrics' };
  }
  armWithLyrics(room, lyrics, null);
  return { ok: true };
}

function armWithLyrics(room, lyrics, bcp47) {
  room.lyrics = lyrics;
  room.settings.lang = bcp47 || detectLanguage(lyrics.lines.map((l) => l.text).join('\n')).bcp47;
  setRuntime(room, room.track?.durationMs || lyrics.durationMs || 0);
  if (room.settings.mode === 'master') {
    room.phase = 'singers';
  } else {
    drawSingers(room);
    room.phase = 'armed';
  }
}

function setRuntime(room, ms) {
  room.roundMs = ms > 0 ? Math.min(MAX_ROUND_MS, ms) : FALLBACK_ROUND_MS;
}

/** [SPOTIFY — kept for rollback] The host found the chosen song on Spotify (random mode). */
export function setMedia(room, { uri, art, durationMs }) {
  if (!room.track) return;
  room.track.resolving = false;
  if (uri) room.track.uri = String(uri).slice(0, 120);
  if (art) room.track.art = String(art).slice(0, 400);
  const d = Number(durationMs);
  // Only trust Spotify's length when it is the same recording as the lyrics.
  if (d > 0 && (!room.lyrics?.durationMs || Math.abs(d - room.lyrics.durationMs) < 8000)) {
    room.track.durationMs = d;
    setRuntime(room, d);
  }
}

/* --- YouTube ------------------------------------------------------------- */

/** The server found (or was handed) the videos for this track. */
export function setVideos(room, videos, error = null) {
  const t = room.track;
  if (!t) return;
  t.resolving = false;
  t.videos = Array.isArray(videos) ? videos.slice(0, 8) : [];
  t.videoError = t.videos.length ? null : (error || 'none');
  t.videoIdx = 0;
  useVideo(room, 0);
}

/** Switch to candidate i ("Wrong video? Next one"). Returns false when there are no more. */
export function useVideo(room, i) {
  const t = room.track;
  if (!t) return false;
  const v = t.videos?.[i];
  if (!v) {
    t.video = null;
    if (t.videos?.length) t.videoError = 'blocked';
    return false;
  }
  t.videoIdx = i;
  t.video = v;
  t.videoError = null;
  if (v.thumb) t.art = v.thumb;
  // The round lasts as long as the video. The lyric sheet's length is only a
  // fallback when the video's length is not known yet (a pasted link).
  const lyricMs = room.lyrics?.durationMs || 0;
  t.durationMs = v.durationMs || lyricMs;
  t.offByMs = v.durationMs && lyricMs ? v.durationMs - lyricMs : 0;
  setRuntime(room, t.durationMs);
  return true;
}

/** Pick a member who has not sung yet this cycle; everyone gets a turn. */
function randomMember(team) {
  const fresh = team.members.filter((m) => !team.sung.has(m));
  const from = fresh.length ? fresh : team.members;
  return from[Math.floor(Math.random() * from.length)] || team.name;
}

export function drawSingers(room) {
  room.singers = {};
  for (const t of room.teams.values()) room.singers[t.id] = randomMember(t);
}

/** Game master: explicit picks; any team left out is drawn at random. */
export function setSingers(room, picks) {
  if (room.phase !== 'singers' && room.phase !== 'armed') return false;
  room.singers = {};
  for (const t of room.teams.values()) {
    const want = picks?.[t.id];
    room.singers[t.id] = t.members.includes(want) ? want : randomMember(t);
  }
  room.phase = 'armed';
  return true;
}

/** Suggestions for the game master's "random" buttons, fair-rotation aware. */
export function suggestSingers(room) {
  return Object.fromEntries([...room.teams.values()].map((t) => [t.id, randomMember(t)]));
}

export function beginCountdown(room) {
  if (room.phase !== 'armed' || !room.lyrics || room.teams.size < 1) return false;
  if (room.music === 'youtube' && !room.track?.video) return false;
  clearTimers(room);
  room.lastResult = null;
  for (const t of room.teams.values()) {
    t.heard = '';
    t.clips = new Map();
    t.inflight = 0;
    t.finalIn = false;
    t.clipSeen = false;
    t.live = blankLive();
    const singer = room.singers[t.id];
    if (singer) {
      t.sung.add(singer);
      if (t.members.every((m) => t.sung.has(m))) t.sung = new Set([singer]);
    }
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

/** Host reported real playback: lock the round to the audio and run to the end. */
export function lockWindow(room, positionMs, onEnd, durationMs = 0) {
  if (room.phase !== 'countdown' && room.phase !== 'live') return;
  // A pasted YouTube link has no known length until the player loads it.
  if (durationMs > 0 && room.track && !room.track.video?.durationMs && room.music === 'youtube') {
    room.track.durationMs = durationMs;
    if (room.track.video) room.track.video.durationMs = durationMs;
    setRuntime(room, durationMs);
  }
  const from = Number.isFinite(positionMs) && positionMs > 0 ? positionMs : 0;
  const remaining = Math.max(10000, room.roundMs - from);
  room.round.fromMs = from;
  room.round.timeline = buildTimeline(room.lyrics.lines, from, from + remaining);
  room.round.target = room.round.timeline.all;
  room.round.startedAt = now();
  room.round.endsAt = now() + remaining;
  room.phase = 'live';
  room.onEnd = onEnd;
  clearTimers(room);
  room.endTimer = setTimeout(() => onEnd(room), remaining);
  room.timers.push(room.endTimer);
}

/**
 * The host reports where the video really is every few seconds. If it
 * buffered or stalled, slide the round's clock so the lyrics keep lining up
 * with the audio and the round still ends when the song does.
 */
export function resync(room, positionMs) {
  if (room.phase !== 'live' || !room.round?.startedAt || !Number.isFinite(positionMs)) return false;
  const drift = playhead(room) - positionMs;          // + = our clock is ahead of the audio
  if (Math.abs(drift) < 350) return false;
  room.round.startedAt += drift;
  const remaining = Math.max(1000, room.round.fromMs + room.roundMs - positionMs);
  room.round.endsAt = now() + remaining;
  if (room.endTimer) clearTimeout(room.endTimer);
  const onEnd = room.onEnd;
  room.endTimer = setTimeout(() => onEnd?.(room), remaining);
  room.timers.push(room.endTimer);
  return true;
}

const playhead = (room) => room.round.fromMs + (now() - room.round.startedAt);
const accepting = (room) => room.phase === 'live' || room.phase === 'scoring';

/* --- hearing -------------------------------------------------------------- */

/** Clips can finish out of order, so they are kept by sequence and re-joined. */
export function hearClip(room, team, roundNo, seq, text) {
  if (!accepting(room) || roundNo !== room.roundNo) return false;
  team.clips.set(seq, String(text || ''));
  const joined = [...team.clips.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]).join(' ');
  return hear(room, team, joined);
}

export function hear(room, team, text) {
  if (!accepting(room)) return false;
  team.heard = String(text || '').slice(0, 30000);
  rescoreAll(room);
  return true;
}

export function rescoreAll(room) {
  if (!accepting(room) || !room.round?.timeline) return;
  const due = room.phase === 'live' ? targetSoFar(room.round.timeline, playhead(room)) : room.round.target;
  for (const t of room.teams.values()) {
    t.live = score(due, tokenize(t.heard), { phraseFloor: t.live.phrase });
  }
}

export function startTicker(room, onTick) {
  if (room.ticker) clearInterval(room.ticker);
  room.ticker = setInterval(() => {
    if (room.phase !== 'live') { clearInterval(room.ticker); room.ticker = null; return; }
    rescoreAll(room);
    onTick(room);
  }, 1000);
}

/** The music stopped. Wait for every phone's last clip, then score. */
export function endLive(room, onDone) {
  if (room.phase === 'countdown') { finishRound(room); return onDone(room); }
  if (room.phase !== 'live') return;
  clearTimers(room);
  room.phase = 'scoring';
  room.scoringSince = now();
  later(room, SCORING_WAIT_MS, () => { if (room.phase === 'scoring') { finishRound(room); onDone(room); } });
  checkScoringDone(room, onDone);
}

/** Called whenever a clip lands during scoring. */
export function checkScoringDone(room, onDone) {
  if (room.phase !== 'scoring') return;
  // Every connected phone recording through Groq sends a final clip when the
  // music stops; wait for it (and anything still being transcribed). A phone
  // that went quiet is covered by the SCORING_WAIT_MS timeout.
  const waiting = [...room.teams.values()].some((t) =>
    t.connected && t.micOk && t.engine === 'groq' && (!t.finalIn || t.inflight > 0));
  if (waiting) return;
  finishRound(room);
  onDone(room);
}

/**
 * Ranked points: you score one point for every team you beat, so with four
 * teams it is 3 / 2 / 1 / 0, and teams that tie share the same points.
 */
export function finishRound(room) {
  clearTimers(room);
  room.phase = 'reveal';
  const target = room.round?.target ?? [];
  const rows = teamList(room).map((t) => {
    const s = score(target, tokenize(t.heard), { exact: true });
    return { id: t.id, name: t.name, slot: t.slot, singer: room.singers[t.id] || '', percent: s.percent, hits: s.hits, total: s.total, phrase: s.phrase };
  });
  const better = (a, b) => a.percent - b.percent || a.phrase - b.phrase;
  for (const r of rows) {
    r.gain = r.percent > 0 ? rows.filter((o) => o !== r && better(r, o) > 0).length : 0;
    const t = room.teams.get(r.id);
    t.points += r.gain;
    t.lastGain = r.gain;
  }
  rows.sort((a, b) => better(b, a));
  const top = rows[0];
  const tie = rows.length > 1 && better(rows[0], rows[1]) === 0;
  const winner = top && top.percent > 0 && !tie ? top : null;
  if (room.song) room.played.add(room.song.id);
  room.history.push({ roundNo: room.roundNo, title: room.track?.name, artist: room.track?.artist, winnerId: winner?.id ?? null });
  room.lastResult = {
    roundNo: room.roundNo,
    rows,
    winnerId: winner?.id ?? null,
    tie: Boolean(tie && top.percent > 0),
    lineText: (room.round?.timeline?.lines ?? room.lyrics?.lines ?? []).map((l) => l.text),
    last: room.roundNo >= room.settings.rounds,
  };
  return room.lastResult;
}

/** After the reveal: next round, or the final standings. */
export function advance(room) {
  if (room.phase !== 'reveal') return null;
  if (room.roundNo >= room.settings.rounds) {
    room.phase = 'final';
    return null;
  }
  return nextRound(room);
}

/** Final screen → back to setup with the same teams and zeroed scores. */
export function restartSameTeams(room) {
  clearTimers(room);
  room.phase = 'setup';
  room.roundNo = 0;
  room.track = null; room.song = null; room.lyrics = null; room.round = null;
  room.lastResult = null; room.options = null; room.singers = {};
  for (const t of room.teams.values()) { t.points = 0; t.lastGain = 0; t.live = blankLive(); t.heard = ''; }
}

/** Wipe the teams entirely (the host tells the phones to go). */
export function clearTeams(room) {
  restartSameTeams(room);
  const gone = [...room.teams.values()];
  room.teams.clear();
  return gone;
}

/* --- views ---------------------------------------------------------------- */

export function snapshot(room) {
  const teams = teamList(room);
  const standings = [...teams].sort((a, b) => b.points - a.points);
  return {
    code: room.code,
    phase: room.phase,
    music: room.music,
    clipMs: clipMsFor(teams.length),
    settings: { mode: room.settings.mode, rounds: room.settings.rounds, langs: room.settings.langs, lang: room.settings.lang },
    roundNo: room.roundNo,
    chooserId: room.chooserId,
    options: room.options?.map(({ _lyrics, ...o }) => o) ?? null,
    optionsError: room.optionsError,
    track: room.track,
    song: room.song,
    roundMs: room.roundMs ?? 0,
    lineCount: room.lyrics?.lines.length ?? 0,
    singers: room.singers,
    countdownStartsAt: room.round?.startsAt ?? null,
    endsAt: room.round?.endsAt ?? null,
    teams: teams.map((t) => ({
      id: t.id,
      slot: t.slot,
      name: t.name,
      members: t.members,
      points: t.points,
      lastGain: t.lastGain,
      connected: t.connected,
      micOk: t.micOk,
      engine: t.engine,
      percent: t.live.percent,
      hits: t.live.hits,
      total: t.live.total,
      rank: standings.findIndex((s) => s.id === t.id),
    })),
    result: room.lastResult,
    history: room.history,
    serverNow: now(),
  };
}

export const COUNTDOWN = COUNTDOWN_MS;

/**
 * Groq's free tier allows 20 transcriptions a minute for the whole server. Four
 * phones at 15 s clips is 16/min; ten phones need ~34 s clips to stay under.
 * Longer clips are also a little MORE accurate (more context for Whisper), the
 * price is that the live percentage moves in bigger steps.
 */
export function clipMsFor(n) {
  const need = Math.ceil((60 * Math.max(1, n)) / GROQ_PER_MINUTE) * 1000;
  return Math.max(CLIP_MIN_MS, need);
}

function shuffle(a) {
  const arr = [...a];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

setInterval(() => {
  const cutoff = now() - IDLE_ROOM_MS;
  for (const [code, room] of rooms) {
    if (room.touchedAt < cutoff) { clearTimers(room); rooms.delete(code); }
  }
}, 60000).unref?.();
