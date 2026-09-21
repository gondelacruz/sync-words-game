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
  hear, finishRound, resetForNext, resetMatch, snapshot, startTicker, COUNTDOWN,
} from './rooms.js';
import { detectLanguage } from './lyrics.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

const app = express();
app.disable('x-powered-by');
app.use(express.static(join(__dirname, '..', 'public'), { extensions: ['html'] }));

app.get('/api/config', (_req, res) => {
  res.json({
    spotifyClientId: process.env.SPOTIFY_CLIENT_ID || '',
    configured: Boolean(process.env.SPOTIFY_CLIENT_ID),
  });
});

app.get('/api/room/:code', (req, res) => {
  const room = getRoom(req.params.code);
  if (!room) return res.status(404).json({ ok: false });
  res.json({ ok: true, phase: room.phase, players: room.players.size });
});

app.use(express.json({ limit: '10mb' }));

app.post('/api/transcribe', async (req, res) => {
  try {
    const { audio, language } = req.body;
    
    if (!audio || !Buffer.isBuffer(Buffer.from(audio, 'base64'))) {
      return res.status(400).json({ error: 'Invalid audio data' });
    }
    
    const audioBuffer = Buffer.from(audio, 'base64');
    const lang = language || 'en-US';
    
    // Call Groq Whisper API
    const formData = new FormData();
    formData.append('file', new Blob([audioBuffer], { type: 'audio/wav' }), 'audio.wav');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('language', lang.split('-')[0]); // Convert 'es-ES' to 'es'
    
    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    });
    
    if (!response.ok) {
      const err = await response.text();
      console.error('Groq error:', err);
      return res.status(500).json({ error: 'Transcription failed' });
    }
    
    const result = await response.json();
    res.json({ text: result.text || '' });
  } catch (error) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: error.message });
  }
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
  if (!process.env.SPOTIFY_CLIENT_ID) {
    console.log('  (no SPOTIFY_CLIENT_ID set — see .env.example)\n');
  }
});
