// ---------------------------------------------------------------------------
// SYNG — HTTP + WebSocket server.
// Serves three screens (landing / host / play) and brokers one room per code.
// ---------------------------------------------------------------------------

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRoom, getRoom, addTeam, setTeamInfo, removeTeam, startGame, nextRound,
  beginSelection, dealOptions, chooseOption, armTrack, setMedia, setSingers, suggestSingers,
  beginCountdown, lockWindow, hear, hearClip, startTicker, endLive, checkScoringDone,
  advance, restartSameTeams, clearTeams, snapshot, COUNTDOWN,
} from './rooms.js';
import { transcribe, sttEnabled } from './stt.js';
import { LANGUAGES } from './songs.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/api/config', (_req, res) => {
  res.json({
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    configured: Boolean(process.env.SPOTIFY_CLIENT_ID),
    // 'groq' = phones record clips and the server transcribes them;
    // 'browser' = phones use the browser's own speech recognition.
    stt: sttEnabled() ? 'groq' : 'browser',
    languages: LANGUAGES,
  });
});

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false });
  res.json({ ok: true, phase: room.phase, teams: room.teams.size });
});

// A phone uploads one audio clip. Only accepted from a real team in a round
// that is live (or just finished and waiting for last clips), so nobody can
// burn the Groq quota from outside.
app.post('/api/transcribe',
  express.raw({ type: () => true, limit: '6mb' }),
  async (req, res) => {
    const room = getRoom(req.query.code);
    const team = room?.teams.get(String(req.query.pid || ''));
    const roundNo = Number(req.query.round);
    const seq = Number(req.query.seq);
    const final = req.query.final === '1';
    if (!room || !team) return res.status(404).json({ ok: false, reason: 'no-team' });
    const open = (room.phase === 'live' || room.phase === 'scoring') && roundNo === room.roundNo;
    if (!open) return res.json({ ok: false, reason: 'not-live' });
    if (!Number.isFinite(seq)) return res.status(400).json({ ok: false, reason: 'bad-clip' });

    team.clipSeen = true;
    const tiny = !Buffer.isBuffer(req.body) || req.body.length < 200;
    if (final) team.finalIn = true;
    if (tiny) {
      checkScoringDone(room, onScored);
      return res.json({ ok: true, text: '' });
    }

    team.inflight += 1;
    let text = '';
    try {
      const iso = String(room.settings.lang || 'en').slice(0, 2);
      text = await transcribe(req.body, String(req.headers['content-type'] || ''), iso);
    } catch (e) {
      console.warn('[stt]', e.message);
    } finally {
      team.inflight -= 1;
    }

    if (text && hearClip(room, team, roundNo, seq, text)) push(room);
    checkScoringDone(room, onScored);
    res.json({ ok: true, text });
  });

app.get('/healthz', (_req, res) => res.type('text').send('ok'));

const server = createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const send = (ws, msg) => {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
};

function broadcast(room, msg) {
  send(room.hostSocket, msg);
  for (const t of room.teams.values()) send(t.socket, msg);
}

function push(room) {
  room.touchedAt = Date.now();
  const state = snapshot(room);
  send(room.hostSocket, { t: 'state', room: state });
  for (const t of room.teams.values()) {
    send(t.socket, { t: 'state', room: state, you: t.id });
  }
}

/** The round's result is in. */
function onScored(room) {
  broadcast(room, { t: 'fx', kind: 'reveal' });
  push(room);
}

/** The music stopped (track ended, host cut it, or the timer ran out). */
function stopMusic(room) {
  if (room.phase !== 'live' && room.phase !== 'countdown') return;
  send(room.hostSocket, { t: 'stop' });
  endLive(room, onScored);
  push(room);
}

/** After a song is locked in, tell everyone who is singing. */
function announce(room) {
  broadcast(room, { t: 'fx', kind: 'singers', singers: room.singers, roundNo: room.roundNo });
}

/** Deal fresh options, pushing once while they load and again when they land. */
async function deal(room, promise) {
  push(room);
  await promise;
  push(room);
}

/** The song is known in random mode: the host looks it up on Spotify. */
function afterChoice(room, song) {
  if (!song) return;
  send(room.hostSocket, { t: 'resolve', song: { title: song.title, artist: song.artist, durationMs: room.track?.durationMs || 0 } });
  push(room);
  announce(room);
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let room = null;
  let team = null;
  let isHost = false;

  const fail = (reason) => send(ws, { t: 'error', reason });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg.t !== 'string') return;

    // ---- handshake ----------------------------------------------------
    if (msg.t === 'host:hello') {
      room = msg.code ? getRoom(msg.code) : null;
      if (!room) room = createRoom();
      if (room.hostSocket && room.hostSocket !== ws) try { room.hostSocket.close(); } catch {}
      room.hostSocket = ws;
      isHost = true;
      send(ws, { t: 'welcome', role: 'host', code: room.code });
      // A reloaded host mid-random-round still needs the Spotify lookup.
      if (room.track?.resolving) send(ws, { t: 'resolve', song: { title: room.track.name, artist: room.track.artist, durationMs: room.track.durationMs } });
      return push(room);
    }

    if (msg.t === 'join') {
      room = getRoom(msg.code);
      if (!room) return fail('no-room');
      const out = addTeam(room, { name: msg.name, members: msg.members, teamId: msg.teamId });
      if (out.error) return fail(out.error);
      team = out.team;
      if (team.socket && team.socket !== ws) try { team.socket.close(); } catch {}
      team.socket = ws;
      team.connected = true;
      send(ws, { t: 'welcome', role: 'team', code: room.code, teamId: team.id, slot: team.slot });
      broadcast(room, { t: 'fx', kind: 'joined', name: team.name, slot: team.slot });
      return push(room);
    }

    if (!room) return fail('no-session');
    room.touchedAt = Date.now();

    // ---- team (phone) messages ----------------------------------------
    if (team) {
      switch (msg.t) {
        case 'team:mic':
          team.micOk = Boolean(msg.ok);
          team.engine = String(msg.engine || '').slice(0, 40) || null;
          return push(room);
        case 'team:info':
          if (setTeamInfo(room, team, { name: msg.name, members: msg.members })) push(room);
          return;
        case 'team:heard':                       // browser speech engine only
          if (hear(room, team, msg.text)) push(room);
          return;
        case 'team:choose':
          if (room.chooserId !== team.id) return fail('not-your-turn');
          return afterChoice(room, chooseOption(room, msg.idx));
        default:
          return;
      }
    }

    // ---- host messages --------------------------------------------------
    if (!isHost) return;

    switch (msg.t) {
      case 'host:start': {
        if (!startGame(room, msg)) return fail('need-a-team');
        return deal(room, nextRound(room));
      }

      case 'host:kick': {
        const gone = removeTeam(room, String(msg.teamId || ''));
        if (gone) { send(gone.socket, { t: 'error', reason: 'kicked' }); push(room); }
        return;
      }

      // Random mode: the host picks for a team whose phone has gone quiet.
      case 'host:choose':
        return afterChoice(room, chooseOption(room, msg.idx));

      // Random mode: three new songs. Game master: back to search.
      case 'host:different':
        if (!['choosing', 'pick', 'singers', 'armed'].includes(room.phase)) return;
        return deal(room, beginSelection(room));

      case 'host:reshuffle':
        if (room.phase !== 'choosing') return;
        return deal(room, dealOptions(room));

      // Game master: a track from Spotify search (or typed, in manual mode).
      case 'host:track': {
        const t = msg.track || {};
        if (!t.name) return fail('bad-track');
        const pending = armTrack(room, {
          id: t.id, uri: t.uri, name: String(t.name).slice(0, 200), artist: String(t.artist || '').slice(0, 200),
          album: t.album, art: t.art, durationMs: Number(t.durationMs) || 0,
        });
        push(room);
        const out = await pending;
        if (!out.ok && out.reason !== 'superseded') send(ws, { t: 'nolyrics', reason: out.reason });
        if (out.ok) send(ws, { t: 'suggest', singers: suggestSingers(room) });
        return push(room);
      }

      case 'host:suggest':
        return send(ws, { t: 'suggest', singers: suggestSingers(room) });

      case 'host:media':
        setMedia(room, msg);
        return push(room);

      case 'host:singers':
        if (!setSingers(room, msg.singers)) return;
        push(room);
        return announce(room);

      case 'host:go': {
        if (!beginCountdown(room)) return fail('not-ready');
        broadcast(room, { t: 'fx', kind: 'countdown', ms: COUNTDOWN });
        push(room);
        setTimeout(() => {
          if (room.phase !== 'countdown') return;
          send(room.hostSocket, { t: 'play', positionMs: room.round.fromMs });
          broadcast(room, { t: 'fx', kind: 'go' });
        }, COUNTDOWN);
        return;
      }

      case 'host:playing':
        lockWindow(room, Number(msg.positionMs), stopMusic);
        startTicker(room, push);
        return push(room);

      case 'host:ended':
      case 'host:abort':
        return stopMusic(room);

      case 'host:next': {
        const p = advance(room);
        if (p) return deal(room, p);
        return push(room);
      }

      case 'host:restart':
        restartSameTeams(room);
        return push(room);

      case 'host:newteams':
        for (const t of clearTeams(room)) send(t.socket, { t: 'error', reason: 'kicked' });
        return push(room);

      default:
        return;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (isHost && room.hostSocket === ws) room.hostSocket = null;
    if (team && team.socket === ws) {
      team.connected = false;
      team.socket = null;
      push(room);
      checkScoringDone(room, onScored);
    }
  });
});

// Keep Render's proxy from culling idle sockets.
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { ws.terminate(); continue; }
    ws.isAlive = false;
    try { ws.ping(); } catch {}
  }
}, 25000).unref?.();

server.listen(PORT, () => {
  console.log(`\n  SYNG  ->  http://127.0.0.1:${PORT}\n`);
  console.log(`  speech-to-text: ${sttEnabled() ? 'Groq Whisper' : 'browser (no GROQ_API_KEY set)'}\n`);
  if (!process.env.SPOTIFY_CLIENT_ID) {
    console.log('  (no SPOTIFY_CLIENT_ID set — see .env.example)\n');
  }
});
