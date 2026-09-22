// ---------------------------------------------------------------------------
// End-to-end smoke test: boots the server and drives one host and team phones
// over real WebSockets through both game modes, both music sources (the
// Spotify path is kept working for rollback), and a full room of ten teams.
// YouTube's API is faked by a tiny local server.
//   node scripts/simulate.js
// ---------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import WebSocket from 'ws';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const PORT = 4571;
const YT_PORT = 4572;
const YT_CACHE = join(tmpdir(), `syng-yt-cache-${process.pid}.json`);

// ---- a fake YouTube Data API ---------------------------------------------------
// For "<artist> <title>" it offers a live cut, a lyric video, a music video that
// is 40 s longer, and the "Artist - Topic" studio upload, which should win.
const ytCalls = { search: 0, videos: 0 };
const fakeVideos = new Map();
const vid = (tag, n) => (tag + String(n).padStart(11, '0')).slice(0, 11);
let ytN = 0;
const ytServer = createServer((req, res) => {
  const u = new URL(req.url, 'http://x');
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (u.searchParams.get('key') !== 'test-key') return json(400, { error: { errors: [{ reason: 'keyInvalid' }] } });
  if (u.pathname === '/search') {
    ytCalls.search++;
    const q = u.searchParams.get('q') || '';
    if (/quota/i.test(q)) return json(403, { error: { errors: [{ reason: 'quotaExceeded' }] } });
    const artist = q.split(' ')[0];
    ytN++;
    const list = [
      { id: vid('L', ytN), title: `${q} (Live at Wembley)`, channel: `${artist}VEVO`, dur: 'PT0M16S' },
      { id: vid('Y', ytN), title: `${q} (Lyrics)`, channel: 'Lyrics Hub', dur: 'PT0M14S' },
      { id: vid('M', ytN), title: `${q} (Official Video)`, channel: `${artist}VEVO`, dur: 'PT0M54S' },
      { id: vid('T', ytN), title: q.split(' ').slice(1).join(' '), channel: `${artist} - Topic`, dur: 'PT0M14S' },
    ];
    for (const v of list) fakeVideos.set(v.id, v);
    return json(200, { items: list.map((v) => ({ id: { videoId: v.id } })) });
  }
  if (u.pathname === '/videos') {
    ytCalls.videos++;
    const ids = (u.searchParams.get('id') || '').split(',');
    const items = ids.map((id) => fakeVideos.get(id) || (id === 'dQw4w9WgXcQ' ? { id, title: 'Pasted Song', channel: 'Someone', dur: 'PT3M33S' } : null))
      .filter(Boolean)
      .map((v) => ({ id: v.id, snippet: { title: v.title, channelTitle: v.channel, thumbnails: {} }, contentDetails: { duration: v.dur }, status: { embeddable: true } }));
    return json(200, { items });
  }
  json(404, {});
});
await new Promise((r) => ytServer.listen(YT_PORT, r));

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
  env: {
    ...process.env, PORT: String(PORT), GROQ_API_KEY: '', SYNC_LYRICS_FIXTURE: join(here, 'fixture.lrc'),
    MUSIC_SOURCE: '', YOUTUBE_API_KEY: 'test-key', YOUTUBE_API_BASE: `http://127.0.0.1:${YT_PORT}`, YOUTUBE_CACHE_FILE: YT_CACHE,
  },
  stdio: ['ignore', 'pipe', 'inherit'],
});
server.stdout.on('data', () => {});
const bye = (code) => { server.kill(); ytServer.close(); try { rmSync(YT_CACHE); } catch {} process.exit(code); };
process.on('uncaughtException', (e) => { console.error(e); bye(1); });
await wait(700);

console.log('\nSYNG end-to-end\n');

const cfg = await fetch(`http://127.0.0.1:${PORT}/api/config`).then((r) => r.json());
check('YouTube is the default music source', cfg.music === 'youtube', cfg.music);
check('the jukebox has 1000+ songs', cfg.songCount >= 1000, String(cfg.songCount));
check('ten teams allowed', cfg.maxTeams === 10, String(cfg.maxTeams));

// ---- [SPOTIFY rollback path] host + two teams ------------------------------------
console.log('\n  -- Spotify (kept for rollback) --');
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
host.tx({ t: 'host:hello', music: 'spotify' });
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

// ---- YouTube: random mode ------------------------------------------------------------
console.log('\n  -- YouTube --');
let Y = null, ycode = null, yplay = null, ystop = false, yerr = null;
const yhost = await open((m) => {
  if (m.t === 'welcome') ycode = m.code;
  if (m.t === 'state') Y = m.room;
  if (m.t === 'play') yplay = m.positionMs;
  if (m.t === 'stop') ystop = true;
  if (m.t === 'videoerror') yerr = m.reason;
});
yhost.tx({ t: 'host:hello' });
await wait(200);
check('a host with no preference gets YouTube', Y?.music === 'youtube', Y?.music);
const ya = await open(() => {});
const yb = await open(() => {});
ya.tx({ t: 'join', code: ycode, name: 'Uno', members: ['A1', 'A2'] });
yb.tx({ t: 'join', code: ycode, name: 'Dos', members: ['B1'] });
await wait(200);
yhost.tx({ t: 'host:start', mode: 'random', rounds: 2, langs: ['en'] });
await wait(700);
check('YouTube game deals three songs', Y.options?.length === 3);
const ySong = Y.options[0];
yhost.tx({ t: 'host:choose', idx: 0 });
await wait(400);
check('server found the video by itself', Boolean(Y.track?.video) && !Y.track.resolving, JSON.stringify(Y.track?.videoError));
check('the studio "Topic" upload beats live / lyric / music-video cuts', / - Topic$/.test(Y.track.video?.channel || ''), Y.track.video?.title);
check('round length follows the video', Y.roundMs === 14000, String(Y.roundMs));
check('one search per new song', ytCalls.search === 1, String(ytCalls.search));

yhost.tx({ t: 'host:nextvideo' });
await wait(150);
check('"Wrong video? Next match" switches to the runner-up', Y.track.videoIdx === 1 && Y.track.video.id !== Y.track.videos[0].id);
yhost.tx({ t: 'host:video', url: 'not a link' });
await wait(150);
check('a bad pasted link is refused', yerr === 'bad-link', yerr);
yhost.tx({ t: 'host:video', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10' });
await wait(250);
check('a pasted YouTube link becomes the video', Y.track.video?.id === 'dQw4w9WgXcQ' && Y.track.video.durationMs === 213000, Y.track.video?.id);
check('…and the round follows its length', Y.roundMs === 213000, String(Y.roundMs));
yhost.tx({ t: 'host:nextvideo' });
await wait(150);
check('the automatic matches are still there after pasting', Y.track.videoIdx === 1);

yhost.tx({ t: 'host:go' });
await wait(3700);
check('host told to play the video from the top', yplay === 0, String(yplay));
yhost.tx({ t: 'host:playing', positionMs: 40, durationMs: 14000 });
await wait(150);
check('YouTube round is live', Y.phase === 'live');
const endsBefore = Y.endsAt;
await wait(1200);
yhost.tx({ t: 'host:pos', positionMs: 200 });                    // the video stalled ~1s
await wait(150);
check('buffering drift pushes the end of the round back', Y.endsAt - endsBefore > 700, String(Y.endsAt - endsBefore));
ya.tx({ t: 'team:heard', text: 'is this the real life is this just fantasy' });
await wait(200);
yhost.tx({ t: 'host:ended' });
await wait(300);
check('video end stops the round', ystop && Y.phase === 'reveal', Y.phase);

yhost.tx({ t: 'host:next' });
await wait(700);
const again = Y.options.findIndex((o) => o.title !== ySong.title);
const before = ytCalls.search;
yhost.tx({ t: 'host:choose', idx: again });
await wait(400);
check('round 2 found its video too', Boolean(Y.track.video), JSON.stringify(Y.track.videoError));
check('each new song costs exactly one search', ytCalls.search === before + 1, `${before} -> ${ytCalls.search}`);
await wait(1700);
check('matches are saved to the cache file', existsSync(YT_CACHE) && Object.keys(JSON.parse(readFileSync(YT_CACHE, 'utf8'))).length >= 2);

// ---- YouTube: game master, search, cache, quota ---------------------------------------------
const found = await fetch(`http://127.0.0.1:${PORT}/api/search?q=queen`).then((r) => r.json());
check('free song search answers', found.ok && found.items.length > 0 && found.items[0].title, JSON.stringify(found.items?.[0]));
yhost.tx({ t: 'host:restart' });
await wait(150);
yhost.tx({ t: 'host:start', mode: 'master', rounds: 3 });
await wait(150);
const s0 = ytCalls.search;
yhost.tx({ t: 'host:track', track: { name: ySong.title, artist: ySong.artist, durationMs: 14000 } });
await wait(500);
check('game master: video found for the picked song', Boolean(Y.track?.video) && Y.phase === 'singers', Y.phase);
check('a song played before costs no search (cached)', ytCalls.search === s0, `${s0} -> ${ytCalls.search}`);
yhost.tx({ t: 'host:different' });
await wait(150);
yhost.tx({ t: 'host:track', track: { name: 'Quota Song', artist: 'Nobody', durationMs: 14000 } });
await wait(500);
check('when YouTube says the quota is gone, the host is asked for a link', !Y.track.video && Y.track.videoError === 'quota', Y.track.videoError);
const q = await fetch(`http://127.0.0.1:${PORT}/api/youtube`).then((r) => r.json());
check('…and the server stops searching until the reset', q.searchesLeft === 0 && q.resetsAt > Date.now(), JSON.stringify(q));
yhost.tx({ t: 'host:singers', singers: {} });
await wait(150);
yhost.tx({ t: 'host:go' });
await wait(150);
check('no video = cannot start the round', Y.phase === 'armed', Y.phase);
yhost.tx({ t: 'host:video', url: 'youtu.be/dQw4w9WgXcQ' });
await wait(250);
check('a pasted link rescues the round', Y.track.video?.id === 'dQw4w9WgXcQ');
check('a video much longer than the lyrics is flagged', Y.track.offByMs === 213000 - 14000, String(Y.track.offByMs));
for (const w of [yhost, ya, yb]) w.close();

// ---- ten teams ------------------------------------------------------------------------------------
console.log('\n  -- Ten teams --');
let T = null, tcode = null;
const thost = await open((m) => { if (m.t === 'welcome') tcode = m.code; if (m.t === 'state') T = m.room; });
thost.tx({ t: 'host:hello', music: 'manual' });
await wait(200);
const phones = [];
for (let i = 0; i < 10; i++) {
  const inbox = [];
  const ws = await open((m) => inbox.push(m));
  ws.inbox = inbox;
  ws.tx({ t: 'join', code: tcode, name: `Team ${i + 1}`, members: [`P${i}a`, `P${i}b`] });
  phones.push(ws);
}
await wait(400);
check('ten teams join', T.teams.length === 10, String(T.teams.length));
check('ten different colour slots', new Set(T.teams.map((t) => t.slot)).size === 10);
const extra = [];
const eleventh = await open((m) => extra.push(m));
eleventh.tx({ t: 'join', code: tcode, name: 'Eleven' });
await wait(200);
check('an eleventh team is turned away', extra.some((m) => m.t === 'error' && m.reason === 'room-full'));
check('with ten phones the clips get longer to stay under Groq\'s limit', T.clipMs === 34000, String(T.clipMs));
check('…and stay at 15 s for four or fewer', S.clipMs === 15000, String(S.clipMs));
thost.tx({ t: 'host:start', mode: 'master', rounds: 1 });
await wait(150);
thost.tx({ t: 'host:track', track: { name: 'Bohemian Rhapsody', artist: 'Queen', durationMs: 14000 } });
await wait(400);
thost.tx({ t: 'host:singers', singers: {} });
await wait(150);
check('everyone gets a singer', Object.keys(T.singers).length === 10);
thost.tx({ t: 'host:go' });
await wait(3700);
thost.tx({ t: 'host:playing', positionMs: 0 });
await wait(150);
const words = full.split(' ');
phones.forEach((p, i) => p.tx({ t: 'team:heard', text: words.slice(0, 3 * i).join(' ') }));
await wait(300);
thost.tx({ t: 'host:ended' });
await wait(400);
const gains = T.result.rows.map((r) => r.gain).join(',');
check('ranked points with ten teams: 9,8,…,1,0', gains === '9,8,7,6,5,4,3,2,1,0', gains);
check('the best singer wins', T.result.winnerId === T.teams[9].id);

console.log(`\n${failures ? failures + ' FAILED' : 'all green'}\n`);
bye(failures ? 1 : 0);
