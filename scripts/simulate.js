// ---------------------------------------------------------------------------
// End-to-end smoke test: boots the server, drives one host and two phones over
// real WebSockets, and checks a full round scores and resolves correctly.
//   node scripts/simulate.js
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 4571;
// The fixture "track" is 40s long, so the whole-song round is 40s. We drive the
// clock forward by scoring against a playhead we control instead of waiting.
const TRACK_MS = 14000;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra ? '  ->  ' + extra : ''}`);
  if (!ok) failures++;
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function open(onMsg) {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.on('message', (raw) => { try { onMsg(JSON.parse(raw)); } catch {} });
  ws.tx = (m) => ws.send(JSON.stringify(m));
  return new Promise((res) => ws.on('open', () => res(ws)));
}

const server = spawn(process.execPath, [join(root, 'server', 'index.js')], {
  env: { ...process.env, PORT: String(PORT), SYNC_LYRICS_FIXTURE: join(here, 'fixture.lrc') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', () => {});

const bye = (code) => { server.kill(); process.exit(code); };
process.on('uncaughtException', (e) => { console.error(e); bye(1); });

await wait(700);

console.log('\nSYNC end-to-end\n');

// ---- host ------------------------------------------------------------------
let code = null, hostState = null, playPos = null, gotStop = false;
const host = await open((m) => {
  if (m.t === 'welcome') code = m.code;
  if (m.t === 'state') hostState = m.room;
  if (m.t === 'play') playPos = m.positionMs;
  if (m.t === 'stop') gotStop = true;
});
host.tx({ t: 'host:hello' });
await wait(250);
check('host gets a 4-character room code', /^[A-Z0-9]{4}$/.test(code || ''), code);

host.tx({ t: 'host:settings', winAt: 2 });
await wait(120);

// ---- players ---------------------------------------------------------------
const seen = { a: [], b: [] };
const a = await open((m) => seen.a.push(m));
const b = await open((m) => seen.b.push(m));
a.tx({ t: 'join', code, name: 'Gon' });
b.tx({ t: 'join', code, name: 'Rival' });
await wait(250);
check('both phones joined', hostState?.players.length === 2, `${hostState?.players.length} players`);
check('phones get distinct slots',
  seen.a.find((m) => m.t === 'welcome')?.slot !== seen.b.find((m) => m.t === 'welcome')?.slot);

a.tx({ t: 'player:mic', ok: true, engine: 'test' });
b.tx({ t: 'player:mic', ok: true, engine: 'test' });
await wait(120);
check('host sees mics armed', hostState.players.every((p) => p.micOk));

// ---- pick a track ----------------------------------------------------------
host.tx({ t: 'host:track', track: {
  id: 't1', uri: 'spotify:track:t1', name: 'Bohemian Rhapsody',
  artist: 'Queen', album: 'A Night at the Opera', durationMs: TRACK_MS, art: '',
} });
await wait(400);
check('lyrics resolved and round armed', hostState.phase === 'armed', hostState.phase);
check('the round is the whole track', hostState.roundMs === TRACK_MS, String(hostState.roundMs));
check('host sees the full lyric sheet', hostState.lineCount === 7, String(hostState.lineCount));

// ---- go --------------------------------------------------------------------
host.tx({ t: 'host:go' });
await wait(200);
check('phase is countdown', hostState.phase === 'countdown', hostState.phase);
check('phones were told to count down', seen.a.some((m) => m.t === 'fx' && m.kind === 'countdown'));

await wait(3600);
check('host was told to start playback at the top', playPos === 0, String(playPos));

const liveStartedAt = Date.now();
host.tx({ t: 'host:playing', positionMs: 0 });
await wait(200);
check('phase is live', hostState.phase === 'live', hostState.phase);
check('round runs the whole track', hostState.endsAt - liveStartedAt > TRACK_MS - 1500,
  `${Math.round((hostState.endsAt - liveStartedAt) / 1000)}s`);
check('target is every word in the song', hostState.targetCount === 30, String(hostState.targetCount));

// ---- sing ------------------------------------------------------------------
// Gon knows it. Rival mumbles a couple of words and gives up.
// Only ~3s of the track has played, so the live meter should be judging Gon
// against the first line alone, not the whole song he has not heard yet.
a.tx({ t: 'player:heard', text: 'is this the real life' });
b.tx({ t: 'player:heard', text: 'is this uhh whatever' });
await wait(400);

let liveA = hostState.players.find((p) => p.name === 'Gon');
let liveB = hostState.players.find((p) => p.name === 'Rival');
check('live meter judges only the line that has played', liveA.total === 5, `total=${liveA.total}`);
check('nailing that line reads 100', liveA.percent === 100, liveA.percent + '%');
check('weak singer scores partially', liveB.percent > 0 && liveB.percent < 70, liveB.percent + '%');

// Let three more lines go past, then re-send the same transcript. The target
// grew underneath them, so the same words are now worth proportionally less.
console.log('  ...letting the track play on');
await wait(4600);
a.tx({ t: 'player:heard', text: 'is this the real life' });
await wait(350);
liveA = hostState.players.find((p) => p.name === 'Gon');
check('target grows as the song plays', liveA.total > 5 && liveA.total <= 30, `total=${liveA.total}`);
check('same words are worth less once more has played', liveA.percent < 60, liveA.percent + '%');

// Now sing the rest of the song and let the host call it early, as if the
// track had run out.
const full = 'is this the real life is this just fantasy caught in a landslide no escape from reality open your eyes look up to the skies and see nothing really matters anyone can see';
a.tx({ t: 'player:heard', text: full });
await wait(300);

// ---- resolve ---------------------------------------------------------------
host.tx({ t: 'host:ended' });
await wait(400);

check('the track ending closed the round', hostState.phase === 'reveal', hostState.phase);
check('host was told to stop the music', gotStop);
const res = hostState.result;
check('final score is against the entire song', res?.rows[0].total === 30, String(res?.rows[0].total));
check('the better singer won the point', res?.winnerId === liveA.id);
check('winner has 1 point', hostState.players.find((p) => p.name === 'Gon').points === 1);
check('loser has 0 points', hostState.players.find((p) => p.name === 'Rival').points === 0);
check('reveal shows the whole lyric sheet', (res?.lineText || []).length === 7, String(res?.lineText?.length));
check('phones received the result', seen.a.at(-1)?.t === 'state' && Boolean(seen.a.at(-1).room.result));

// ---- spam defence ----------------------------------------------------------
host.tx({ t: 'host:next' });
await wait(150);
check('board resets for the next song', hostState.phase === 'lobby' && !hostState.track);

console.log(`\n${failures ? failures + ' FAILED' : 'all green'}\n`);
bye(failures ? 1 : 0);
