// ---------------------------------------------------------------------------
// End-to-end smoke test: boots the server and drives one host and two team
// phones over real WebSockets through both game modes.
//   node scripts/simulate.js
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 4571;

let failures = 0;
const check = (label, ok, extra = '') => {
  console.log(`${ok ? '  PASS' : '  FAIL'}  ${label}${extra !== '' ? '  ->  ' + extra : ''}`);
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
  env: { ...process.env, PORT: String(PORT), GROQ_API_KEY: '', SYNC_LYRICS_FIXTURE: join(here, 'fixture.lrc') },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', () => {});
const bye = (code) => { server.kill(); process.exit(code); };
process.on('uncaughtException', (e) => { console.error(e); bye(1); });
await wait(700);

console.log('\nSYNG end-to-end\n');

// ---- host + two teams --------------------------------------------------------
let code = null, S = null, playPos = null, gotStop = false, resolveMsg = null;
const fx = [];
const host = await open((m) => {
  if (m.t === 'welcome') code = m.code;
  if (m.t === 'state') S = m.room;
  if (m.t === 'play') playPos = m.positionMs;
  if (m.t === 'stop') gotStop = true;
  if (m.t === 'resolve') resolveMsg = m.song;
  if (m.t === 'fx') fx.push(m);
});
host.tx({ t: 'host:hello' });
await wait(250);
check('host gets a 4-character room code', /^[A-Z0-9]{4}$/.test(code || ''), code);
check('room starts in setup', S?.phase === 'setup', S?.phase);

const seen = { a: [], b: [] };
const a = await open((m) => seen.a.push(m));
const b = await open((m) => seen.b.push(m));
a.tx({ t: 'join', code, name: 'Los Gatos', members: ['Gon', 'Maria', 'Luis'] });
b.tx({ t: 'join', code, name: 'Rivals', members: ['Ana'] });
await wait(250);
check('both teams joined', S.teams.length === 2, `${S.teams.length} teams`);
check('members arrive with the team', S.teams[0].members.join(',') === 'Gon,Maria,Luis', S.teams[0].members.join(','));
const idA = seen.a.find((m) => m.t === 'welcome').teamId;
const idB = seen.b.find((m) => m.t === 'welcome').teamId;

a.tx({ t: 'team:info', members: ['Gon', 'Maria', 'Luis', 'Pepe'] });
a.tx({ t: 'team:mic', ok: true, engine: 'test' });
b.tx({ t: 'team:mic', ok: true, engine: 'test' });
await wait(150);
check('a team can edit its members in setup', S.teams[0].members.length === 4);

// ---- random mode, 2 rounds ------------------------------------------------------
host.tx({ t: 'host:start', mode: 'random', rounds: 2, langs: ['es', 'en'] });
await wait(700);
check('game starts in choosing', S.phase === 'choosing', S.phase);
check('round 1 of 2', S.roundNo === 1 && S.settings.rounds === 2, `${S.roundNo}/${S.settings.rounds}`);
check('team 1 chooses first', S.chooserId === idA);
check('three songs on offer', S.options?.length === 3, String(S.options?.length));
check('offered songs are in the chosen languages', S.options.every((o) => ['es', 'en'].includes(o.lang)), S.options.map((o) => o.lang).join(','));

b.tx({ t: 'team:choose', idx: 0 });
await wait(150);
check('the other team cannot choose', S.phase === 'choosing');

const chosen = S.options[1];
a.tx({ t: 'team:choose', idx: 1 });
await wait(250);
check('choice arms the round with singers drawn', S.phase === 'armed', S.phase);
check('host is asked to find the song on Spotify', resolveMsg?.title === chosen.title, resolveMsg?.title);
check('one singer per team, from its members', S.singers[idA] && S.teams[0].members.includes(S.singers[idA]) && S.singers[idB] === 'Ana');
check('everyone hears the singer announcement', seen.a.some((m) => m.t === 'fx' && m.kind === 'singers') && fx.some((m) => m.kind === 'singers'));
host.tx({ t: 'host:media', uri: 'spotify:track:x', art: '', durationMs: 0 });
await wait(120);
check('Spotify match stored on the track', S.track.uri === 'spotify:track:x' && !S.track.resolving);
const firstSinger = S.singers[idA];

host.tx({ t: 'host:go' });
await wait(3700);
check('host told to play from the top', playPos === 0, String(playPos));
host.tx({ t: 'host:playing', positionMs: 0 });
await wait(150);
check('round is live', S.phase === 'live', S.phase);

const full = 'is this the real life is this just fantasy caught in a landslide no escape from reality open your eyes look up to the skies and see nothing really matters anyone can see';
a.tx({ t: 'team:heard', text: full });
b.tx({ t: 'team:heard', text: 'is this uhh whatever' });
await wait(300);
host.tx({ t: 'host:ended' });
await wait(400);
check('music stops', gotStop);
check('round resolves to the reveal', S.phase === 'reveal', S.phase);
const r1 = S.result;
check('better team wins', r1.winnerId === idA);
check('ranked points: winner +1 with two teams', r1.rows.find((r) => r.id === idA).gain === 1 && r1.rows.find((r) => r.id === idB).gain === 0);
check('reveal carries the lyric sheet', r1.lineText.length === 7, String(r1.lineText.length));
check('reveal knows who sang', r1.rows.find((r) => r.id === idA).singer === firstSinger);

host.tx({ t: 'host:next' });
await wait(700);
check('round 2 starts choosing', S.phase === 'choosing' && S.roundNo === 2);
check('choosing rotates to team 2', S.chooserId === idB);
check('the song just played is not offered again', !S.options.some((o) => o.title === chosen.title && o.artist === chosen.artist));
b.tx({ t: 'team:choose', idx: 2 });
await wait(250);
check('singer rotation: team 1 gets someone new', S.singers[idA] !== firstSinger, `${firstSinger} -> ${S.singers[idA]}`);
host.tx({ t: 'host:media' });
host.tx({ t: 'host:go' });
await wait(3700);
host.tx({ t: 'host:playing', positionMs: 0 });
await wait(150);
a.tx({ t: 'team:heard', text: 'is this the real life' });
b.tx({ t: 'team:heard', text: full });
await wait(300);
host.tx({ t: 'host:abort' });
await wait(400);
check('round 2 resolves', S.phase === 'reveal' && S.result.last === true);
check('points add up across rounds', S.teams.every((t) => t.points === 1), S.teams.map((t) => t.points).join(','));

host.tx({ t: 'host:next' });
await wait(200);
check('after the last round: final standings', S.phase === 'final', S.phase);

// ---- play again with the same teams, now as game master --------------------------
host.tx({ t: 'host:restart' });
await wait(200);
check('restart keeps the teams', S.phase === 'setup' && S.teams.length === 2);
check('restart zeroes the scores', S.teams.every((t) => t.points === 0));

let suggest = null;
host.on('message', (raw) => { const m = JSON.parse(raw); if (m.t === 'suggest') suggest = m.singers; });
host.tx({ t: 'host:start', mode: 'master', rounds: 1 });
await wait(200);
check('game master mode: host picks the song', S.phase === 'pick' && S.settings.mode === 'master', S.phase);
host.tx({ t: 'host:track', track: { id: 't1', uri: 'spotify:track:t1', name: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 14000 } });
await wait(400);
check('then picks the singers', S.phase === 'singers', S.phase);
check('server suggests fair random singers', suggest && suggest[idA] && suggest[idB] === 'Ana');
host.tx({ t: 'host:singers', singers: { [idA]: 'Pepe', [idB]: 'Ana' } });
await wait(200);
check('chosen singers are announced', S.phase === 'armed' && S.singers[idA] === 'Pepe');
check('round runs the whole track', S.roundMs === 14000, String(S.roundMs));

host.tx({ t: 'host:different' });
await wait(150);
check('"Different song" goes back to search', S.phase === 'pick');

// ---- a phone joining mid-game is turned away; a new game needs setup ------------
const late = [];
const c = await open((m) => late.push(m));
c.tx({ t: 'join', code, name: 'Latecomers' });
await wait(200);
check('new teams cannot join a running game', late.some((m) => m.t === 'error' && m.reason === 'game-running'));

host.tx({ t: 'host:restart' });
await wait(120);
host.tx({ t: 'host:newteams' });
await wait(200);
check('"New teams" clears the room', S.teams.length === 0);
check('phones are told to leave', seen.a.some((m) => m.t === 'error' && m.reason === 'kicked'));

console.log(`\n${failures ? failures + ' FAILED' : 'all green'}\n`);
bye(failures ? 1 : 0);
