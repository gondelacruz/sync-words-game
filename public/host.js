// ---------------------------------------------------------------------------
// SYNG — the host screen (laptop). Owns the music and the big display.
//
// MUSIC SOURCES
//   youtube (default) — an embedded YouTube player (public/youtube.js); the
//                       server finds the video (server/youtube.js).
//   spotify           — KEPT FOR ROLLBACK, fully working: Spotify Web Playback
//                       SDK (public/spotify.js). Every Spotify-only branch in
//                       this file is marked [SPOTIFY]. To revert: README →
//                       "Revert to Spotify" (set MUSIC_SOURCE=spotify, or open
//                       the host with ?music=spotify).
//   manual            — ?manual=1: the host plays the song from anywhere.
// ---------------------------------------------------------------------------

import { $, $$, colorFor, connect, confetti, shake, ordinal } from '/lib.js';
import * as sp from '/spotify.js';        // [SPOTIFY — kept for rollback]
import * as yt from '/youtube.js';

const el = {
  musicChip: $('#musicChip'), teamsChip: $('#teamsChip'), roundChip: $('#roundChip'), quitBtn: $('#quitBtn'),
  codeBox: $('#codeBox'), joinUrl: $('#joinUrl'), teamSlots: $('#teamSlots'),
  needSpotify: $('#needSpotify'), loginBtn: $('#loginBtn'), cfgWarn: $('#cfgWarn'),
  rounds: $('#rounds'), langWrap: $('#langWrap'), langDD: $('#langDD'), langSummary: $('#langSummary'), langMenu: $('#langMenu'),
  startBtn: $('#startBtn'), startHint: $('#startHint'),
  chooserName: $('#chooserName'), optionCards: $('#optionCards'), optionsMsg: $('#optionsMsg'), reshuffleBtn: $('#reshuffleBtn'),
  q: $('#q'), results: $('#results'), searchHint: $('#searchHint'),
  singSong: $('#singSong'), singerCols: $('#singerCols'), lockBtn: $('#lockBtn'), randAllBtn: $('#randAllBtn'),
  armArt: $('#armArt'), armTitle: $('#armTitle'), armArtist: $('#armArtist'), armWindow: $('#armWindow'),
  ytSlotArmed: $('#ytSlotArmed'), ytSlotLive: $('#ytSlotLive'), liveGrid: $('#liveGrid'), ytNote: $('#ytNote'),
  videoBar: $('#videoBar'), videoWhat: $('#videoWhat'), nextVideoBtn: $('#nextVideoBtn'), ytSearchLink: $('#ytSearchLink'),
  pasteForm: $('#pasteForm'), pasteUrl: $('#pasteUrl'), videoMsg: $('#videoMsg'),
  lineup: $('#lineup'), goBtn: $('#goBtn'), reannBtn: $('#reannBtn'), armHint: $('#armHint'),
  liveTitle: $('#liveTitle'), liveArtist: $('#liveArtist'), clock: $('#clock'), timeBar: $('#timeBar'), arena: $('#arena'), stopBtn: $('#stopBtn'),
  revStamp: $('#revStamp'), revRows: $('#revRows'), revLyrics: $('#revLyrics'), nextBtn: $('#nextBtn'),
  champName: $('#champName'), champLine: $('#champLine'), standings: $('#standings'), finalRounds: $('#finalRounds'),
  againBtn: $('#againBtn'), newTeamsBtn: $('#newTeamsBtn'),
  announce: $('#announce'), annRound: $('#annRound'), annRows: $('#annRows'), annSong: $('#annSong'),
  countOverlay: $('#countOverlay'), countNum: $('#countNum'), scoringOverlay: $('#scoringOverlay'),
  views: {
    setup: $('#viewSetup'), choosing: $('#viewChoosing'), pick: $('#viewPick'), singers: $('#viewSingers'),
    armed: $('#viewArmed'), live: $('#viewLive'), reveal: $('#viewReveal'), final: $('#viewFinal'),
  },
};

// Manual mode: SYNG plays nothing. You play the song from wherever you like and
// SYNG just runs the clock. Lyrics still come from LRCLIB.
const QS = new URLSearchParams(location.search);
const MANUAL = QS.has('manual');
// 'youtube' | 'spotify' | 'manual' — decided at boot from ?manual, ?music= and the server's MUSIC_SOURCE.
let MUSIC = MANUAL ? 'manual' : 'youtube';
const usesYT = () => MUSIC === 'youtube';
const usesSpotify = () => MUSIC === 'spotify';       // [SPOTIFY]
const LANG_NAMES = {
  'en-US': 'English', 'es-ES': 'Spanish', 'pt-BR': 'Portuguese', 'fr-FR': 'French',
  'de-DE': 'German', 'it-IT': 'Italian', 'zh-CN': 'Chinese', 'ja-JP': 'Japanese',
  'ko-KR': 'Korean', 'ru-RU': 'Russian', 'ar-SA': 'Arabic',
};

// The host's game preferences survive reloads and future games on this laptop.
const store = {
  get(k, d) { try { const v = localStorage.getItem('syng:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('syng:' + k, JSON.stringify(v)); } catch {} },
};
const prefs = {
  mode: store.get('mode', 'random') === 'master' ? 'master' : 'random',
  rounds: clampRounds(store.get('rounds', 5)),
  langs: store.get('langs', ['en']),
};
if (!Array.isArray(prefs.langs) || !prefs.langs.length) prefs.langs = ['en'];
function clampRounds(n) { return Math.min(30, Math.max(1, Math.round(Number(n) || 5))); }

let clientId = '';                 // [SPOTIFY]
let ytStatus = null;
let maxTeams = 10;
let languages = [{ iso: 'en', name: 'English' }];
let state = null;
let net = null;
let lastPhase = null;
let lastRevealRound = -1;
let lastFinalShown = false;
let picks = {};              // game master: teamId -> member
let suggestions = {};

const escape_ = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clockText = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const teamById = (id) => state?.teams.find((t) => t.id === id);

/* --- boot ---------------------------------------------------------------- */
(async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  if (!MANUAL) MUSIC = ['youtube', 'spotify'].includes(QS.get('music')) ? QS.get('music') : (cfg.music === 'spotify' ? 'spotify' : 'youtube');
  // Coming back from Spotify's login page means Spotify, whatever the default.
  if (!MANUAL && QS.has('code')) MUSIC = 'spotify';
  clientId = cfg.spotifyClientId || '';
  ytStatus = cfg.youtube || null;
  maxTeams = cfg.maxTeams || 10;
  if (cfg.languages?.length) languages = cfg.languages;
  if (usesSpotify() && !cfg.configured) el.cfgWarn.classList.remove('hide');
  buildSettings();

  if (usesYT()) {
    yt.load({
      onReady: () => { paintMusic(); render(); },
      onEnded: () => { if (state?.phase === 'live') net.send({ t: 'host:ended' }); },
      onError: onVideoError,
      onBlocked: () => { el.liveArtist.textContent = 'Your browser blocked autoplay: click the video once to start it'; },
    });
  }
  // [SPOTIFY — kept for rollback]
  if (usesSpotify() && clientId) {
    await sp.completeLogin(clientId);
    if (sp.isLoggedIn()) startPlayer();
  }
  paintMusic();
  if (MANUAL) {
    el.q.placeholder = 'Artist - Title, then hit "Use this title"';
    $('#manualGo').classList.remove('hide');
    $('#manualGo').addEventListener('click', pickManualTrack);
    el.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') pickManualTrack(); });
  }

  net = connect({
    onOpen: (api) => api.send({ t: 'host:hello', music: MUSIC, code: sessionStorage.getItem('syng:code') || undefined }),
    onMessage: handle,
    onDrop: () => { el.teamsChip.textContent = 'reconnecting…'; },
  });
})();

/* --- [SPOTIFY — kept for rollback] player ------------------------------------ */
let sawPlayback = false;
function startPlayer() {
  sp.createPlayer(clientId, {
    onReady: () => { paintMusic(); render(); },
    onState: (st) => {
      if (!st) return;
      if (!st.paused) { sawPlayback = true; return; }
      // Spotify parks a finished track at position 0, paused: the song ended.
      if (sawPlayback && st.position === 0 && state?.phase === 'live') {
        sawPlayback = false;
        net.send({ t: 'host:ended' });
      }
    },
    onError: (kind, msg) => {
      paintMusic();
      if (kind === 'account_error') el.musicChip.textContent = 'Spotify Premium required';
      else if (kind === 'authentication_error') sp.logout();
      console.warn('[spotify]', kind, msg);
    },
  });
}

function paintMusic() {
  if (MANUAL) {
    el.musicChip.textContent = 'Manual mode';
    el.musicChip.classList.add('hot');
    el.needSpotify.classList.add('hide');
    return;
  }
  if (usesYT()) {
    const ready = yt.playerReady();
    el.musicChip.textContent = ready ? 'YouTube: ready' : 'YouTube: loading…';
    el.musicChip.classList.toggle('hot', ready);
    el.needSpotify.classList.add('hide');
    if (ytStatus) {
      const note = !ytStatus.enabled
        ? 'No YOUTUBE_API_KEY on the server: you will paste a YouTube link for each song (see README).'
        : ytStatus.searchesLeft < 15
          ? `${ytStatus.searchesLeft} YouTube searches left today (songs played before are free). Refills at ${new Date(ytStatus.resetsAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`
          : '';
      el.ytNote.textContent = note;
      el.ytNote.classList.toggle('hide', !note);
    }
    return;
  }
  // [SPOTIFY — kept for rollback]
  const inOk = sp.isLoggedIn();
  const ready = sp.playerReady();
  el.musicChip.textContent = !inOk ? 'Spotify: offline' : ready ? 'Spotify: ready' : 'Spotify: waking…';
  el.musicChip.classList.toggle('hot', ready);
  el.needSpotify.classList.toggle('hide', inOk);
}
el.loginBtn.addEventListener('click', () => clientId && sp.login(clientId));

/* --- setup controls ---------------------------------------------------------- */
function buildSettings() {
  el.rounds.value = prefs.rounds;
  el.langMenu.innerHTML = languages.map((l) => `
    <label class="ddopt"><input type="checkbox" value="${l.iso}" ${prefs.langs.includes(l.iso) ? 'checked' : ''}><span>${escape_(l.name)}</span></label>`).join('');
  paintSettings();
}

function paintSettings() {
  for (const b of $$('.mode')) b.classList.toggle('on', b.dataset.mode === prefs.mode);
  el.langWrap.classList.toggle('hide', prefs.mode !== 'random');
  const names = languages.filter((l) => prefs.langs.includes(l.iso)).map((l) => l.name);
  el.langSummary.textContent = names.length ? names.join(', ') : 'English';
}

for (const b of $$('.mode')) {
  b.addEventListener('click', () => { prefs.mode = b.dataset.mode; store.set('mode', prefs.mode); paintSettings(); });
}
const setRounds = (n) => { prefs.rounds = clampRounds(n); el.rounds.value = prefs.rounds; store.set('rounds', prefs.rounds); };
$('#roundsDown').addEventListener('click', () => setRounds(prefs.rounds - 1));
$('#roundsUp').addEventListener('click', () => setRounds(prefs.rounds + 1));
el.rounds.addEventListener('change', () => setRounds(el.rounds.value));
el.langMenu.addEventListener('change', () => {
  const chosen = $$('input', el.langMenu).filter((i) => i.checked).map((i) => i.value);
  if (!chosen.length) {                       // at least one language, always
    $$('input', el.langMenu).find((i) => i.value === 'en').checked = true;
    chosen.push('en');
  }
  prefs.langs = chosen;
  store.set('langs', chosen);
  paintSettings();
});
document.addEventListener('click', (e) => { if (!el.langDD.contains(e.target)) el.langDD.open = false; });

el.startBtn.addEventListener('click', () => {
  net.send({ t: 'host:start', mode: prefs.mode, rounds: prefs.rounds, langs: prefs.langs });
});

/* --- socket -------------------------------------------------------------- */
function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      sessionStorage.setItem('syng:code', msg.code);
      break;
    case 'state':
      state = msg.room;
      render();
      break;
    case 'fx':
      if (msg.kind === 'countdown') runCountdown(msg.ms);
      if (msg.kind === 'joined') shake(document.querySelector('.stage'), 260);
      if (msg.kind === 'singers') setTimeout(() => showAnnouncement(msg.singers, msg.roundNo), 60);
      break;
    case 'resolve':
      resolveSong(msg.song);
      break;
    case 'suggest':
      suggestions = msg.singers || {};
      break;
    case 'play':
      startPlayback(msg.positionMs);
      break;
    case 'stop':
      stopMusic();
      break;
    case 'videoerror':
      el.videoMsg.textContent = {
        'bad-link': 'That does not look like a YouTube link.',
        'not-found': 'YouTube says that video does not exist.',
        'no-embed': 'That video does not allow playing outside YouTube. Try another upload.',
      }[msg.reason] || 'That link did not work.';
      break;
    case 'nolyrics':
      el.searchHint.classList.remove('hide');
      el.searchHint.innerHTML = '<span style="color:var(--p1)">No time-synced lyrics for that one. Try a more famous version — a studio single beats a live or remastered cut.</span>';
      break;
  }
}

/* --- [SPOTIFY — kept for rollback] lookup for a jukebox song (random mode) ---- */
const simplify = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\s-\s.*$/, '').replace(/\(.*?\)|\[.*?\]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

async function resolveSong(song) {
  if (MANUAL || !clientId || !sp.isLoggedIn()) return net.send({ t: 'host:media' });
  let items = [];
  try { items = await sp.search(clientId, `track:${song.title} artist:${song.artist}`); } catch (e) { console.warn(e); }
  if (!items.length) { try { items = await sp.search(clientId, `${song.title} ${song.artist}`); } catch {} }
  const want = simplify(song.title);
  const artist = simplify(song.artist);
  const cost = (t) => {
    const name = simplify(t.name);
    let c = name === want ? 0 : name.startsWith(want) ? 60_000 : 300_000;
    if (!simplify(t.artist).includes(artist.split(' ')[0])) c += 120_000;
    if (song.durationMs) c += Math.abs(t.durationMs - song.durationMs);   // match the lyric sheet's recording
    return c;
  };
  items.sort((a, b) => cost(a) - cost(b));
  const best = items[0];
  net.send({ t: 'host:media', uri: best?.uri, art: best?.art, durationMs: best?.durationMs });
}

/* --- playback ------------------------------------------------------------ */
let posTimer = 0;
function stopMusic() {
  clearInterval(posTimer);
  if (usesYT()) yt.stop();
  if (usesSpotify()) { sawPlayback = false; sp.pause(); }                   // [SPOTIFY]
}

async function startPlayback(positionMs) {
  if (usesYT()) return startYouTube(positionMs);
  if (MANUAL || !state.track?.uri) return net.send({ t: 'host:playing', positionMs: 0 });
  // [SPOTIFY — kept for rollback] from here on
  sawPlayback = false;
  try {
    await sp.playTrack(clientId, state.track.uri, positionMs);
  } catch (e) {
    console.warn('play failed', e);
    net.send({ t: 'host:abort' });
    return;
  }
  // Report where the needle actually landed, so scoring targets the real audio.
  for (let i = 0; i < 14; i++) {
    await new Promise((r) => setTimeout(r, 110));
    const pos = await sp.position();
    if (pos != null && pos > 0) return net.send({ t: 'host:playing', positionMs: pos });
  }
  net.send({ t: 'host:playing', positionMs });
}

async function startYouTube(positionMs) {
  const v = state.track?.video;
  if (!v) return net.send({ t: 'host:abort' });
  el.countOverlay.hidden = true;                      // nothing may cover a playing video
  yt.attach(el.ytSlotLive);
  try {
    const at = await yt.play(v.id, positionMs);
    el.liveArtist.textContent = state.track?.artist || '—';
    net.send({ t: 'host:playing', positionMs: at.positionMs, durationMs: at.durationMs });
  } catch (e) {
    console.warn('[youtube]', e.message);
    if (state?.phase === 'countdown' || state?.phase === 'live') net.send({ t: 'host:abort' });
    return;
  }
  // Every few seconds, tell the server where the audio really is, so a video
  // that buffered does not drift away from the lyric timing.
  clearInterval(posTimer);
  posTimer = setInterval(() => {
    if (state?.phase !== 'live') return clearInterval(posTimer);
    const p = yt.position();
    if (p != null) net.send({ t: 'host:pos', positionMs: p });
  }, 4000);
}

/** The player refused a video (removed, private, or embedding switched off). */
function onVideoError(code) {
  console.warn('[youtube] error', code);
  if (code === 'api-blocked') {
    el.musicChip.textContent = 'YouTube blocked';
    el.musicChip.classList.remove('hot');
    return;
  }
  if (state?.phase === 'live' || state?.phase === 'countdown') {
    stopMusic();
    net.send({ t: 'host:abort' });
    return;
  }
  // Setting up: quietly move on to the next-best match.
  if (state?.track?.video) net.send({ t: 'host:nextvideo' });
}

/* --- overlays ------------------------------------------------------------ */
function runCountdown(ms) {
  el.announce.hidden = true;
  if (usesYT()) { yt.stop(); yt.attach(null); }      // the preview must not keep playing
  el.countOverlay.hidden = false;
  const steps = ['3', '2', '1', 'SING'];
  const each = ms / steps.length;
  steps.forEach((s, i) => setTimeout(() => {
    el.countNum.textContent = s;
    el.countNum.style.animation = 'none';
    void el.countNum.offsetWidth;
    el.countNum.style.animation = '';
    el.countNum.style.color = s === 'SING' ? 'var(--p5)' : 'var(--acid)';
  }, i * each));
  setTimeout(() => { el.countOverlay.hidden = true; }, ms + 260);
}

let annTimer = 0;
function showAnnouncement(singers, roundNo) {
  if (!state) return;
  const teams = state.teams.filter((t) => singers?.[t.id]);
  if (!teams.length) return;
  el.annRound.textContent = roundNo || state.roundNo;
  el.annSong.textContent = state.track ? `${state.track.name} — ${state.track.artist}` : '';
  // Up to four teams: one big name per line with "vs" between. More than that:
  // a grid of smaller names that land faster, so ten teams still fit.
  const many = teams.length > 4;
  const step = many ? 0.22 : 0.55;
  el.annRows.className = 'annRows' + (many ? ' many' : '');
  el.annRows.style.setProperty('--n', teams.length);
  el.annRows.innerHTML = teams.map((t, i) => `
    ${i && !many ? `<div class="annVs" style="animation-delay:${i * step - 0.2}s">vs</div>` : ''}
    <div class="annRow" style="--c:${colorFor(t.slot)};animation-delay:${i * step}s">
      <span class="annTeam">${escape_(t.name)}</span>
      <span class="annName">${escape_(singers[t.id])}</span>
    </div>`).join('');
  el.announce.hidden = false;
  teams.forEach((t, i) => setTimeout(() => {
    shake(el.announce, 300);
    confetti([colorFor(t.slot), '#ffffff'], many ? 30 : 70);
  }, i * step * 1000 + 250));
  clearTimeout(annTimer);
  annTimer = setTimeout(() => { el.announce.hidden = true; }, 3200 + teams.length * step * 1000);
}
el.announce.addEventListener('click', () => { el.announce.hidden = true; });

/* --- song pick (game master) ------------------------------------------------ */
// YouTube (and manual) mode searches LRCLIB through our server: free, no quota,
// and it only lists songs that have synced lyrics. [SPOTIFY] searches Spotify.
let searchTimer = 0;
let searchSeq = 0;
async function findSongs(q) {
  if (usesSpotify()) return sp.search(clientId, q);                 // [SPOTIFY]
  const r = await fetch('/api/search?q=' + encodeURIComponent(q)).then((x) => x.json());
  return (r.items || []).map((t) => ({ id: '', uri: null, name: t.title, artist: t.artist, album: t.album, art: '', durationMs: t.durationMs }));
}
el.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.q.value;
  if (!q.trim()) { el.results.innerHTML = ''; el.searchHint.classList.remove('hide'); return; }
  const mySeq = ++searchSeq;
  searchTimer = setTimeout(async () => {
    let items = [];
    try { items = await findSongs(q); } catch (e) { console.warn(e); }
    if (mySeq !== searchSeq) return;                                  // a newer search is on its way
    el.searchHint.classList.toggle('hide', items.length > 0);
    if (!items.length) el.searchHint.textContent = MANUAL ? 'Not found. Type "Artist - Title" and hit "Use this title".' : 'Nothing found with synced lyrics. Try the artist name too.';
    el.results.innerHTML = '';
    for (const t of items) {
      const b = document.createElement('button');
      b.className = 'result';
      const art = t.art ? `<img src="${t.art}" alt="">` : `<span class="noart">${escape_((t.name || '?')[0])}</span>`;
      b.innerHTML = `${art}<span class="grow"><span class="rt">${escape_(t.name)}</span><br><span class="ra">${escape_(t.artist)}${t.album ? ' · ' + escape_(t.album) : ''} · ${mmss(t.durationMs)}</span></span>`;
      b.addEventListener('click', () => sendTrack(t));
      el.results.appendChild(b);
    }
  }, usesSpotify() ? 260 : 380);
});

function sendTrack(track) {
  el.searchHint.classList.remove('hide');
  el.searchHint.textContent = 'Finding the lyrics…';
  el.results.innerHTML = '';
  net.send({ t: 'host:track', track });
}

function pickManualTrack() {
  const raw = el.q.value.trim();
  if (!raw) return;
  const [artist, ...rest] = raw.split(/\s*[-–]\s*/);
  const title = rest.join(' - ') || artist;
  sendTrack({ id: 'manual', uri: null, name: title, artist: rest.length ? artist : '', album: '', art: '', durationMs: 0 });
}

/* --- singer picks (game master) -------------------------------------------- */
function pickFor(team, name) { picks[team.id] = name; renderSingers(); }
function randomFor(team) {
  const suggested = suggestions[team.id];
  const others = team.members.filter((m) => m !== picks[team.id]);
  const name = suggested && suggested !== picks[team.id] && team.members.includes(suggested)
    ? suggested
    : others[Math.floor(Math.random() * others.length)] || team.members[0];
  delete suggestions[team.id];
  pickFor(team, name);
}
el.singerCols.addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const team = teamById(b.dataset.team);
  if (!team) return;
  if (b.dataset.member !== undefined) pickFor(team, team.members[Number(b.dataset.member)]);
  if (b.dataset.random !== undefined) randomFor(team);
});
el.randAllBtn.addEventListener('click', () => { for (const t of state.teams) randomFor(t); });
el.lockBtn.addEventListener('click', () => net.send({ t: 'host:singers', singers: picks }));

/* --- buttons --------------------------------------------------------------- */
el.reshuffleBtn.addEventListener('click', () => net.send({ t: 'host:reshuffle' }));
el.optionCards.addEventListener('click', (e) => {
  const b = e.target.closest('[data-idx]');
  if (b) net.send({ t: 'host:choose', idx: Number(b.dataset.idx) });
});
for (const b of $$('.diffBtn')) b.addEventListener('click', () => net.send({ t: 'host:different' }));
el.goBtn.addEventListener('click', () => {
  if (usesSpotify()) sp.unlockAudio();                 // [SPOTIFY]
  net.send({ t: 'host:go' });
});
el.nextVideoBtn.addEventListener('click', () => { el.videoMsg.textContent = ''; net.send({ t: 'host:nextvideo' }); });
el.pasteForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const url = el.pasteUrl.value.trim();
  if (!url) return;
  el.videoMsg.textContent = '';
  net.send({ t: 'host:video', url });
  el.pasteUrl.value = '';
});
el.reannBtn.addEventListener('click', () => showAnnouncement(state.singers, state.roundNo));
// "End it here": the music stops at once, not after a round trip to the server.
el.stopBtn.addEventListener('click', () => { stopMusic(); net.send({ t: 'host:abort' }); });
el.nextBtn.addEventListener('click', () => net.send({ t: 'host:next' }));
el.againBtn.addEventListener('click', () => net.send({ t: 'host:restart' }));
el.newTeamsBtn.addEventListener('click', () => {
  if (confirmTwice(el.newTeamsBtn, 'Tap again to clear all teams')) net.send({ t: 'host:newteams' });
});
el.quitBtn.addEventListener('click', () => {
  if (confirmTwice(el.quitBtn, 'Tap again to quit')) net.send({ t: 'host:restart' });
});
el.teamSlots.addEventListener('click', (e) => {
  const b = e.target.closest('[data-kick]');
  if (b && confirmTwice(b, 'Remove?')) net.send({ t: 'host:kick', teamId: b.dataset.kick });
});

/** No browser dialogs: a second click within 3s confirms. */
function confirmTwice(btn, text) {
  if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; return true; }
  btn.dataset.label = btn.textContent;
  btn.dataset.armed = '1';
  btn.textContent = text;
  setTimeout(() => { if (btn.dataset.armed === '1') { btn.dataset.armed = ''; btn.textContent = btn.dataset.label; } }, 3000);
  return false;
}

/* --- render -------------------------------------------------------------- */
const VIEW_OF = {
  setup: 'setup', choosing: 'choosing', pick: 'pick', loading: 'pick', singers: 'singers', armed: 'armed',
  countdown: 'live', live: 'live', scoring: 'live', reveal: 'reveal', final: 'final',
};

function render() {
  if (!state) return;
  const phase = state.phase;
  const view = VIEW_OF[phase] || 'setup';
  for (const [k, node] of Object.entries(el.views)) node.classList.toggle('hide', k !== view);

  el.teamsChip.textContent = `${state.teams.length} team${state.teams.length === 1 ? '' : 's'}`;
  const inGame = phase !== 'setup';
  el.roundChip.classList.toggle('hide', !inGame || phase === 'final');
  el.roundChip.textContent = `Round ${state.roundNo} / ${state.settings.rounds}`;
  el.quitBtn.classList.toggle('hide', !inGame || phase === 'final');
  for (const n of $$('.rNo')) n.textContent = state.roundNo;
  for (const n of $$('.rOf')) n.textContent = state.settings.rounds;
  el.scoringOverlay.hidden = phase !== 'scoring';

  if (view === 'setup') renderSetup();
  if (view === 'choosing') renderChoosing();
  if (view === 'pick') renderPick(phase);
  if (phase === 'singers' && lastPhase !== 'singers') picks = {};
  if (view === 'singers') renderSingers();
  if (view === 'armed') renderArmed();
  if (view === 'live') renderLive();
  if (view === 'reveal') renderReveal();
  if (view === 'final') renderFinal();

  if (phase === 'live' && lastPhase !== 'live') startClock();
  if (phase !== 'live' && lastPhase === 'live') stopClock();
  // Whatever ended the round (the song, "End it here", "Quit to setup"), the music stops.
  if (!['countdown', 'live'].includes(phase) && ['countdown', 'live'].includes(lastPhase)) stopMusic();
  // Where the YouTube player sits: a preview while the round is set up, the left
  // half during the song, parked (hidden) everywhere else.
  if (usesYT()) {
    if (view === 'armed') yt.attach(el.ytSlotArmed);
    else if (phase === 'live' || yt.isLive()) yt.attach(el.ytSlotLive);
    else yt.attach(null);
  }
  if (phase !== 'final') lastFinalShown = false;
  lastPhase = phase;
}

function renderSetup() {
  el.codeBox.innerHTML = [...state.code].map((c) => `<span class="digit">${c}</span>`).join('');
  el.joinUrl.textContent = location.host;
  // Every team that joined, plus one empty slot until the room is full (max 10).
  const shown = Math.min(maxTeams, Math.max(2, ...state.teams.map((t) => t.slot + 1)) + (state.teams.length < maxTeams ? 1 : 0));
  el.teamSlots.classList.toggle('many', shown > 4);
  el.teamSlots.innerHTML = Array.from({ length: shown }, (_, i) => {
    const t = state.teams.find((x) => x.slot === i);
    const c = colorFor(i);
    if (!t) return `<div class="tslot"><span class="label">Team ${i + 1}</span><span class="tn muted">waiting for a phone…</span></div>`;
    return `<div class="tslot filled ${t.connected ? '' : 'dim'}" style="--c:${c}">
      <div class="row" style="justify-content:space-between;gap:8px">
        <span class="label" style="color:${t.micOk ? 'var(--p5)' : 'var(--p1)'}">${t.micOk ? 'mic armed' : 'no mic yet'}</span>
        <button class="kick" data-kick="${t.id}" title="Remove team">✕</button>
      </div>
      <span class="tn" style="color:${c}">${escape_(t.name)}</span>
      <span class="tm">${t.members.map(escape_).join(' · ')}</span>
      <span class="label">${t.members.length} ${t.members.length === 1 ? 'singer' : 'singers'}</span>
    </div>`;
  }).join('');

  const needSpotify = usesSpotify() && !sp.isLoggedIn();              // [SPOTIFY]
  const noTeams = state.teams.length === 0;
  el.startBtn.disabled = needSpotify || noTeams;
  el.startHint.textContent = needSpotify ? 'Connect Spotify first (or use manual mode)'
    : noTeams ? 'Waiting for at least one team to join'
    : state.teams.some((t) => !t.micOk) ? 'Some phones have not armed their mic yet' : `${state.teams.length} team${state.teams.length === 1 ? '' : 's'} ready`;
  picks = {};
}

function renderChoosing() {
  const chooser = teamById(state.chooserId);
  el.chooserName.textContent = chooser ? `${chooser.name} picks` : 'Pick a song';
  el.chooserName.style.color = chooser ? colorFor(chooser.slot) : '';
  const opts = state.options;
  el.optionsMsg.textContent = state.optionsError || (opts ? '' : 'Shuffling the jukebox…');
  el.optionsMsg.style.color = state.optionsError ? 'var(--p1)' : '';
  el.reshuffleBtn.textContent = state.optionsError ? 'Try again' : 'Three different songs';
  el.optionCards.innerHTML = (opts || []).map((o, i) => `
    <button class="optCard" data-idx="${i}" style="--c:${colorFor(i + 1)}">
      <span class="oYear">${o.year || ''}</span>
      <span class="oTitle">${escape_(o.title)}</span>
      <span class="oArtist">${escape_(o.artist)}</span>
    </button>`).join('');
}

function renderPick(phase) {
  if (phase === 'loading') {
    el.searchHint.classList.remove('hide');
    el.searchHint.textContent = 'Finding the lyrics…';
  } else if (lastPhase !== 'pick' && lastPhase !== 'loading') {
    el.q.value = '';
    el.results.innerHTML = '';
    el.searchHint.classList.remove('hide');
    el.searchHint.textContent = MANUAL ? 'Search, or type "Artist - Title" and hit "Use this title".' : 'Type a title or an artist. Only songs with synced lyrics show up.';
    setTimeout(() => el.q.focus(), 50);
  }
}

function renderSingers() {
  if (!state) return;
  el.singSong.textContent = state.track ? `${state.track.name} — ${state.track.artist}` : '';
  el.singerCols.innerHTML = state.teams.map((t) => {
    const c = colorFor(t.slot);
    return `<div class="scol" style="--c:${c}">
      <div class="row" style="justify-content:space-between">
        <span class="tn" style="color:${c}">${escape_(t.name)}</span>
        <button class="ghost" data-team="${t.id}" data-random>Random</button>
      </div>
      <div class="members">${t.members.map((m, i) => `
        <button class="member ${picks[t.id] === m ? 'on' : ''}" data-team="${t.id}" data-member="${i}">${escape_(m)}</button>`).join('')}
      </div>
    </div>`;
  }).join('');
  const missing = state.teams.filter((t) => !picks[t.id]).length;
  el.lockBtn.disabled = missing > 0;
  el.lockBtn.textContent = missing ? `Pick ${missing} more` : 'Announce the singers';
}

function renderArmed() {
  const t = state.track || {};
  el.armArt.src = t.art || '';
  el.armArt.classList.toggle('hide', !t.art || usesYT());
  el.ytSlotArmed.classList.toggle('hide', !usesYT() || !t.video);
  el.lineup.classList.toggle('many', state.teams.length > 4);
  el.armTitle.textContent = t.name || '—';
  el.armArtist.textContent = [t.artist, state.song?.year].filter(Boolean).join(' · ') || '—';
  el.armWindow.textContent = `The whole song · ${mmss(state.roundMs)} · ${state.lineCount} lines · sung in ${LANG_NAMES[state.settings.lang] || state.settings.lang}`;
  el.lineup.innerHTML = state.teams.map((team) => `
    <div class="lu" style="--c:${colorFor(team.slot)}">
      <span class="label" style="color:${colorFor(team.slot)}">${escape_(team.name)}</span>
      <span class="luName">${escape_(state.singers[team.id] || '—')}</span>
      <span class="label" style="color:${team.micOk ? 'var(--p5)' : 'var(--p1)'}">${team.micOk ? 'mic armed' : 'no mic'}</span>
    </div>`).join('');

  let hint = 'Hand each team\'s phone to its singer. Hold it close and belt it.';
  let ok = true;
  if (usesYT()) {
    const r = renderVideoBar(t);
    ok = r.ok;
    if (r.hint) hint = r.hint;
  } else if (usesSpotify()) {                              // [SPOTIFY — kept for rollback]
    if (t.resolving) { ok = false; hint = 'Finding it on Spotify…'; }
    else if (!t.uri) { ok = false; hint = 'Could not find this one on Spotify. Try a different song.'; }
    else if (!sp.playerReady()) { ok = false; hint = 'Waiting for the Spotify player…'; }
  } else {
    hint = 'Get the song ready to play from the very start, then hit Sing!';
  }
  el.goBtn.disabled = !ok;
  el.armHint.textContent = hint;
  el.armHint.style.color = !ok && !t.resolving ? 'var(--p1)' : '';
}

/** YouTube: which video will play, and the ways to change it. */
function renderVideoBar(t) {
  el.videoBar.classList.remove('hide');
  el.ytSearchLink.href = 'https://www.youtube.com/results?search_query=' + encodeURIComponent(`${t.artist || ''} ${t.name || ''}`.trim());
  const v = t.video;
  const more = (t.videos?.length || 0) > (t.videoIdx || 0) + 1;
  el.nextVideoBtn.classList.toggle('hide', !more);
  if (v) {
    yt.cue(v.id);
    const off = Math.round((t.offByMs || 0) / 1000);
    el.videoWhat.innerHTML = `<b>${escape_(v.title)}</b> <span class="muted">· ${escape_(v.channel || 'YouTube')}${v.durationMs ? ' · ' + mmss(v.durationMs) : ''}</span>`
      + (Math.abs(off) >= 8 ? `<div style="color:var(--p6);margin-top:4px">This video is ${Math.abs(off)} s ${off > 0 ? 'longer' : 'shorter'} than the lyrics. It may be a music-video cut (intro/outro), so the words might not line up. Try the next match.</div>` : '');
    if (!yt.playerReady()) return { ok: false, hint: 'Loading the YouTube player…' };
    return { ok: true, hint: '' };
  }
  el.videoWhat.innerHTML = '';
  if (t.resolving) return { ok: false, hint: 'Finding it on YouTube…' };
  const why = {
    nokey: 'No YouTube API key on the server, so paste a link: open "Search YouTube", copy the video\'s address and paste it here.',
    quota: `Today's YouTube searches are used up (they refill at ${new Date(ytStatus?.resetsAt || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}). Songs played before still work. Paste a link for this one.`,
    none: 'YouTube found nothing for this one. Paste a link, or pick a different song.',
    blocked: 'None of the matches can be played here. Paste a link to another upload.',
    error: 'Could not reach YouTube. Paste a link, or try again.',
  }[t.videoError] || 'Paste a YouTube link for this song.';
  if (t.videoError === 'quota' && ytStatus) ytStatus.searchesLeft = 0;
  return { ok: false, hint: why };
}

// Teams as a list of horizontal bars. With YouTube it sits on the right of the
// video; otherwise it takes the whole width. Rows keep their order (by slot)
// so nobody hunts for their team; the leader glows.
function renderLive() {
  const t = state.track || {};
  el.liveTitle.textContent = t.name || '—';
  if (!yt.isLive() || state.phase !== 'countdown') el.liveArtist.textContent = t.artist || '—';
  const n = state.teams.length;
  const withVideo = usesYT() && Boolean(t.video);
  el.ytSlotLive.classList.toggle('hide', !withVideo);
  el.liveGrid.classList.toggle('video', withVideo);
  el.arena.className = 'arena list' + (n > 6 ? ' dense' : '');
  el.arena.style.setProperty('--n', Math.max(n, 2));
  const top = Math.max(0, ...state.teams.map((p) => p.percent));
  el.arena.innerHTML = state.teams.map((team) => {
    const c = colorFor(team.slot);
    const lead = team.percent > 0 && team.percent === top;
    return `<div class="lane ${lead ? 'lead' : ''} ${team.connected ? '' : 'dim'}" style="--c:${c}">
      <div class="fill" style="width:${team.percent}%"></div>
      <div class="laneTop">
        <div class="row" style="gap:8px;align-items:center;flex-wrap:nowrap">
          <span class="dot ${team.micOk ? 'on' : ''}"></span>
          <span class="label lteam" style="color:${c}">${escape_(team.name)} · ${team.points} pts</span>
        </div>
        <div class="pname">${escape_(state.singers[team.id] || team.name)}</div>
      </div>
      <div class="ppct">${team.percent}<span style="font-size:.45em">%</span></div>
    </div>`;
  }).join('');
}

let clockRaf = 0;
function startClock() {
  const loop = () => {
    if (state?.endsAt && state.phase === 'live') {
      const left = Math.max(0, state.endsAt - (Date.now() + clockSkew));
      el.clock.textContent = clockText(left);
      el.timeBar.style.width = (100 * left / Math.max(1, state.roundMs)).toFixed(2) + '%';
      el.clock.style.color = left < 15000 ? 'var(--p1)' : '';
    }
    clockRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(clockRaf);
  clockRaf = requestAnimationFrame(loop);
}
function stopClock() { cancelAnimationFrame(clockRaf); clockRaf = 0; }
let clockSkew = 0;
setInterval(() => { if (state?.serverNow) clockSkew = state.serverNow - Date.now(); }, 2000);

function renderReveal() {
  const r = state.result;
  if (!r) return;
  el.nextBtn.textContent = r.last ? 'Final results' : 'Next round';
  el.revRows.classList.toggle('compact', r.rows.length > 4);
  const win = r.rows.find((x) => x.id === r.winnerId);
  if (r.roundNo !== lastRevealRound) {
    lastRevealRound = r.roundNo;
    el.revStamp.textContent = r.tie ? 'Dead heat' : win ? `${win.name} takes it` : 'Nobody sang';
    el.revStamp.style.color = win ? colorFor(win.slot) : 'var(--mute)';
    el.revStamp.style.fontSize = el.revStamp.textContent.length > 14 ? 'clamp(28px, 6.5vmin, 96px)' : '';
    el.revStamp.style.animation = 'none'; void el.revStamp.offsetWidth; el.revStamp.style.animation = '';
    el.revLyrics.innerHTML = (r.lineText || []).map((l) => `<div>${escape_(l)}</div>`).join('') || '<span class="muted">—</span>';
    shake(document.querySelector('.stage'));
    if (win) confetti([colorFor(win.slot), '#ffffff', '#ffe600'], 120);
  }
  let place = 0;
  el.revRows.innerHTML = r.rows.map((row, i) => {
    if (i && (row.percent !== r.rows[i - 1].percent || row.phrase !== r.rows[i - 1].phrase)) place = i;
    const c = colorFor(row.slot);
    const pts = teamById(row.id)?.points ?? 0;
    return `<div class="panel" style="padding:12px 16px;border-color:${row.id === r.winnerId ? c : 'var(--line)'}">
      <div class="row" style="gap:14px;align-items:baseline">
        <span class="label" style="min-width:3.4ch">${ordinal(place + 1)}</span>
        <span class="d3" style="color:${c};min-width:4.2ch">${row.percent}%</span>
        <span class="grow" style="font-weight:700;font-size:18px">${escape_(row.name)} <span class="muted" style="font-weight:500">· ${escape_(row.singer)}</span></span>
        <span class="label">${row.hits}/${row.total} words</span>
        <span class="d3 gain" style="color:${row.gain ? 'var(--p5)' : 'var(--mute)'}">+${row.gain}</span>
        <span class="d3" style="min-width:2.4ch;text-align:right">${pts}</span>
      </div>
      <div style="height:6px;background:var(--line);margin-top:8px">
        <div style="height:100%;width:${row.percent}%;background:${c};transition:width .6s cubic-bezier(.2,.9,.2,1)"></div>
      </div>
    </div>`;
  }).join('');
}

function renderFinal() {
  const ranked = [...state.teams].sort((a, b) => b.points - a.points);
  const top = ranked[0];
  const tied = ranked.length > 1 && ranked[1].points === top?.points;
  el.finalRounds.textContent = state.settings.rounds;
  el.champName.textContent = !top ? '—' : tied ? 'It\'s a tie' : top.name;
  el.champName.style.color = top && !tied ? colorFor(top.slot) : 'var(--acid)';
  el.champLine.textContent = !top ? '' : tied
    ? `${ranked.filter((t) => t.points === top.points).map((t) => t.name).join(' & ')} · ${top.points} points each`
    : `Champions with ${top.points} points`;
  let place = 0;
  el.standings.innerHTML = ranked.map((t, i) => {
    if (i && t.points !== ranked[i - 1].points) place = i;
    return `<div class="stRow" style="--c:${colorFor(t.slot)}">
      <span class="label">${ordinal(place + 1)}</span>
      <span class="grow stName">${escape_(t.name)}</span>
      <span class="d3">${t.points}</span>
    </div>`;
  }).join('');
  if (!lastFinalShown) {
    lastFinalShown = true;
    confetti(undefined, 260);
    setTimeout(() => confetti(undefined, 180), 500);
  }
}
