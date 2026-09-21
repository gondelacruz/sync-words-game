// ---------------------------------------------------------------------------
// SYNC — HTTP + WebSocket server.
// Serves three screens (landing / host / play) and brokers one room per code.
// ---------------------------------------------------------------------------

import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createRoom, getRoom, addPlayer, armTrack, beginCountdown, lockWindow,
  hear, hearClip, finishRound, resetForNext, resetMatch, snapshot, startTicker, COUNTDOWN,
} from './rooms.js';
import { transcribe, sttEnabled } from './stt.js';

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
  });
});

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false });
  res.json({ ok: true, phase: room.phase, players: room.players.size });
});

// A phone uploads one short audio clip. Only accepted from a real player in a
// room that is live right now, so nobody can burn the Groq quota from outside.
app.post('/api/transcribe',
  express.raw({ type: () => true, limit: '4mb' }),
  async (req, res) => {
    const room = getRoom(req.query.code);
    const player = room?.players.get(String(req.query.pid || ''));
    const roundNo = Number(req.query.round);
    const seq = Number(req.query.seq);
    if (!room || !player) return res.status(404).json({ ok: false, reason: 'no-player' });
    if (room.phase !== 'live' || roundNo !== room.roundNo) return res.json({ ok: false, reason: 'not-live' });
    if (!Buffer.isBuffer(req.body) || req.body.length < 200 || !Number.isFinite(seq)) {
      return res.status(400).json({ ok: false, reason: 'bad-clip' });
    }

    let text = '';
    try {
      const iso = String(room.settings.lang || 'en').slice(0, 2);
      text = await transcribe(req.body, String(req.headers['content-type'] || ''), iso);
    } catch (e) {
      console.warn('[stt]', e.message);
      return res.status(502).json({ ok: false, reason: 'stt-failed' });
    }

    if (hearClip(room, player, roundNo, seq, text)) {
      send(player.socket, { t: 'you', percent: player.live.percent, hits: player.live.hits, phrase: player.live.phrase, matched: player.live.matched.slice(-28) });
      push(room);
    }
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
  for (const p of room.players.values()) send(p.socket, msg);
}

function push(room) {
  room.touchedAt = Date.now();
  const state = snapshot(room);
  send(room.hostSocket, { t: 'state', room: state });
  for (const p of room.players.values()) {
    send(p.socket, { t: 'state', room: state, you: p.id });
  }
}

function endRound(room) {
  const result = finishRound(room);
  broadcast(room, { t: 'fx', kind: 'reveal' });
  push(room);
  send(room.hostSocket, { t: 'stop' });
  return result;
}

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let room = null;
  let player = null;
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
      return push(room);
    }

    if (msg.t === 'join') {
      room = getRoom(msg.code);
      if (!room) return fail('no-room');
      player = addPlayer(room, { name: msg.name, playerId: msg.playerId });
      if (!player) return fail('room-full');
      if (player.socket && player.socket !== ws) try { player.socket.close(); } catch {}
      player.socket = ws;
      player.connected = true;
      send(ws, { t: 'welcome', role: 'player', code: room.code, playerId: player.id, slot: player.slot });
      broadcast(room, { t: 'fx', kind: 'joined', name: player.name, slot: player.slot });
      return push(room);
    }

    if (!room) return fail('no-session');
    room.touchedAt = Date.now();

    // ---- player messages ----------------------------------------------
    if (player) {
      switch (msg.t) {
        case 'player:mic':
          player.micOk = Boolean(msg.ok);
          player.engine = String(msg.engine || '').slice(0, 40) || null;
          return push(room);
        case 'player:ready':
          player.ready = Boolean(msg.ready);
          return push(room);
        case 'player:heard': {
          if (!hear(room, player, msg.text)) return;
          send(ws, { t: 'you', percent: player.live.percent, hits: player.live.hits, phrase: player.live.phrase, matched: player.live.matched.slice(-28) });
          return push(room);
        }
        case 'player:rename':
          player.name = String(msg.name || player.name).slice(0, 14);
          return push(room);
        default:
          return;
      }
    }

    // ---- host messages --------------------------------------------------
    if (!isHost) return;

    switch (msg.t) {
      case 'host:settings': {
        const s = room.settings;
        if (Number.isFinite(msg.winAt)) s.winAt = Math.min(10, Math.max(1, msg.winAt));
        if (typeof msg.lang === 'string') s.lang = msg.lang.slice(0, 10);
        return push(room);
      }

      case 'host:track': {
        const t = msg.track || {};
        if (!t.name) return fail('bad-track');
        push(room);
        const out = await armTrack(room, {
          id: t.id, uri: t.uri, name: t.name, artist: t.artist,
          album: t.album, art: t.art, durationMs: t.durationMs,
        });
        if (!out.ok && out.reason !== 'superseded') send(ws, { t: 'nolyrics', reason: out.reason });
        return push(room);
      }

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

      case 'host:playing': {
        lockWindow(room, Number(msg.positionMs), endRound);
        startTicker(room, push);
        return push(room);
      }

      // The track finished (or the host called it early). Either way, score it.
      case 'host:ended':
      case 'host:abort': {
        if (room.phase === 'countdown' || room.phase === 'live') endRound(room);
        return;
      }

      case 'host:next':
        resetForNext(room);
        return push(room);

      case 'host:reset':
        resetMatch(room);
        return push(room);

      default:
        return;
    }
  });

  ws.on('close', () => {
    if (!room) return;
    if (isHost && room.hostSocket === ws) room.hostSocket = null;
    if (player && player.socket === ws) {
      player.connected = false;
      player.socket = null;
      push(room);
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
  console.log(`\n  SYNC  ->  http://127.0.0.1:${PORT}\n`);
  console.log(`  speech-to-text: ${sttEnabled() ? 'Groq Whisper' : 'browser (no GROQ_API_KEY set)'}\n`);
  if (!process.env.SPOTIFY_CLIENT_ID) {
    console.log('  (no SPOTIFY_CLIENT_ID set — see .env.example)\n');
  }
});
