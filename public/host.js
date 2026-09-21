// ---------------------------------------------------------------------------
// SYNC — the big screen. Owns Spotify playback and all the drama.
// ---------------------------------------------------------------------------

import { $, colorFor, connect, confetti, shake } from '/lib.js';
import * as sp from '/spotify.js';

const el = {
  spotifyChip: $('#spotifyChip'), playersChip: $('#playersChip'),
  codeBox: $('#codeBox'), joinUrl: $('#joinUrl'), lobbyPlayers: $('#lobbyPlayers'),
  needSpotify: $('#needSpotify'), loginBtn: $('#loginBtn'), cfgWarn: $('#cfgWarn'),
  picker: $('#picker'), q: $('#q'), results: $('#results'), searchHint: $('#searchHint'),
  lang: $('#lang'), winAt: $('#winAt'),
  views: {
    lobby: $('#viewLobby'), armed: $('#viewArmed'), live: $('#viewLive'),
    reveal: $('#viewReveal'), champ: $('#viewChamp'),
  },
  armArt: $('#armArt'), armTitle: $('#armTitle'), armArtist: $('#armArtist'),
  armWindow: $('#armWindow'), armRound: $('#armRound'), armWinAt: $('#armWinAt'),
  readyCount: $('#readyCount'),
  goBtn: $('#goBtn'), backBtn: $('#backBtn'), stopBtn: $('#stopBtn'),
  liveTitle: $('#liveTitle'), liveArtist: $('#liveArtist'), clock: $('#clock'),
  timeBar: $('#timeBar'), arena: $('#arena'),
  revRound: $('#revRound'), revStamp: $('#revStamp'), revRows: $('#revRows'), revLyrics: $('#revLyrics'),
  nextBtn: $('#nextBtn'), againBtn: $('#againBtn'), resetBtn: $('#resetBtn'),
  countOverlay: $('#countOverlay'), countNum: $('#countNum'),
};

// Manual mode: no Spotify at all. You play the song from wherever you like and
// SYNC just runs the clock. Lyrics still come from LRCLIB.
const MANUAL = new URLSearchParams(location.search).has('manual');

let clientId = '';
let state = null;
let net = null;
let lastPhase = null;
let lastRoundNo = -1;

const mmss = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const clockText = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/* --- boot ---------------------------------------------------------------- */
(async function boot() {
  const cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({}));
  clientId = cfg.spotifyClientId || '';
  if (!cfg.configured) el.cfgWarn.classList.remove('hide');

  if (clientId && !MANUAL) {
    await sp.completeLogin(clientId);
    if (sp.isLoggedIn()) startPlayer();
  }
  paintSpotify();
  if (MANUAL) {
    el.q.placeholder = 'Artist - Title, then hit "Use this title"';
    $('#manualGo').classList.remove('hide');
    $('#manualGo').addEventListener('click', pickManualTrack);
    el.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') pickManualTrack(); });
  }

  net = connect({
    onOpen: (api) => api.send({ t: 'host:hello', code: sessionStorage.getItem('sync:code') || undefined }),
    onMessage: handle,
    onDrop: () => { el.playersChip.textContent = 'reconnecting…'; },
  });
})();

let sawPlayback = false;

function startPlayer() {
  sp.createPlayer(clientId, {
    onReady: () => paintSpotify(),
    onState: (st) => {
      if (!st) return;
      if (!st.paused) { sawPlayback = true; return; }
      // Spotify parks a finished track at position 0, paused. That is the song
      // ending, not the host pausing mid-way.
      if (sawPlayback && st.position === 0 && state?.phase === 'live') {
        sawPlayback = false;
        net.send({ t: 'host:ended' });
      }
    },
    onError: (kind, msg) => {
      paintSpotify();
      if (kind === 'account_error') {
        el.spotifyChip.textContent = 'Spotify Premium required';
      } else if (kind === 'authentication_error') {
        sp.logout();
      }
      console.warn('[spotify]', kind, msg);
    },
  });
}

function pickManualTrack() {
  const raw = el.q.value.trim();
  if (!raw) return;
  const [artist, ...rest] = raw.split(/\s*[-\u2013]\s*/);
  const title = rest.join(' - ') || artist;
  el.searchHint.classList.remove('hide');
  el.searchHint.textContent = 'Finding the lyrics...';
  net.send({ t: 'host:track', track: {
    id: 'manual', uri: null, name: title, artist: rest.length ? artist : '',
    album: '', art: '', durationMs: 0,
  } });
}

function paintSpotify() {
  if (MANUAL) {
    el.spotifyChip.textContent = 'Manual mode';
    el.spotifyChip.classList.add('hot');
    el.needSpotify.classList.add('hide');
    el.picker.classList.remove('hide');
    return;
  }
  const inOk = sp.isLoggedIn();
  const ready = sp.playerReady();
  el.spotifyChip.textContent = !inOk ? 'Spotify: offline' : ready ? 'Spotify: ready' : 'Spotify: waking…';
  el.spotifyChip.classList.toggle('hot', ready);
  el.needSpotify.classList.toggle('hide', inOk);
  el.picker.classList.toggle('hide', !inOk);
}

el.loginBtn.addEventListener('click', () => clientId && sp.login(clientId));

/* --- socket -------------------------------------------------------------- */
function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      sessionStorage.setItem('sync:code', msg.code);
      break;
    case 'state':
      state = msg.room;
      render();
      break;
    case 'fx':
      if (msg.kind === 'countdown') runCountdown(msg.ms);
      if (msg.kind === 'joined') shake(document.querySelector('.stage'), 260);
      break;
    case 'play':
      startPlayback(msg.positionMs);
      break;
    case 'stop':
      sp.pause();
      break;
    case 'nolyrics':
      el.searchHint.classList.remove('hide');
      el.searchHint.innerHTML = '<span style="color:var(--p1)">No time-synced lyrics for that one. Try a more famous version — a studio single beats a live or remastered cut.</span>';
      break;
  }
}

/* --- playback ------------------------------------------------------------ */
async function startPlayback(positionMs) {
  if (MANUAL) return net.send({ t: 'host:playing', positionMs: 0 });
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

/* --- countdown ----------------------------------------------------------- */
function runCountdown(ms) {
  el.countOverlay.hidden = false;
  const steps = ['3', '2', '1', 'SING'];
  const each = ms / steps.length;
  steps.forEach((s, i) => setTimeout(() => {
    el.countNum.textContent = s;
    el.countNum.style.animation = 'none';
    void el.countNum.offsetWidth;
    el.countNum.style.animation = '';
    el.countNum.style.color = s === 'SING' ? 'var(--p5)' : 'var(--acid)';
    el.countNum.style.fontSize = s === 'SING' ? 'clamp(70px,22vmin,260px)' : '';
  }, i * each));
  setTimeout(() => { el.countOverlay.hidden = true; }, ms + 260);
}

/* --- search -------------------------------------------------------------- */
let searchTimer = 0;
el.q.addEventListener('input', () => {
  clearTimeout(searchTimer);
  const q = el.q.value;
  if (!q.trim()) { el.results.innerHTML = ''; el.searchHint.classList.remove('hide'); return; }
  searchTimer = setTimeout(async () => {
    let items = [];
    try { items = await sp.search(clientId, q); } catch (e) { console.warn(e); }
    el.searchHint.classList.toggle('hide', items.length > 0);
    el.results.innerHTML = '';
    for (const t of items) {
      const b = document.createElement('button');
      b.className = 'result';
      b.innerHTML = `<img src="${t.art}" alt=""><span class="grow"><span class="rt">${escape_(t.name)}</span><br><span class="ra">${escape_(t.artist)} · ${mmss(t.durationMs)}</span></span>`;
      b.addEventListener('click', () => {
        el.searchHint.classList.remove('hide');
        el.searchHint.textContent = 'Finding the lyrics…';
        net.send({ t: 'host:track', track: t });
      });
      el.results.appendChild(b);
    }
  }, 260);
});

const escape_ = (s) => String(s).replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

el.lang.addEventListener('change', () => net.send({ t: 'host:settings', lang: el.lang.value }));
el.winAt.addEventListener('change', () => net.send({ t: 'host:settings', winAt: Number(el.winAt.value) }));

el.goBtn.addEventListener('click', () => { sp.unlockAudio(); net.send({ t: 'host:go' }); });
el.backBtn.addEventListener('click', () => net.send({ t: 'host:next' }));
el.nextBtn.addEventListener('click', () => net.send({ t: 'host:next' }));
el.resetBtn.addEventListener('click', () => net.send({ t: 'host:reset' }));
el.againBtn.addEventListener('click', () => net.send({ t: 'host:reset' }));
el.stopBtn.addEventListener('click', () => net.send({ t: 'host:abort' }));

/* --- render -------------------------------------------------------------- */
function render() {
  if (!state) return;
  const phase = state.phase;

  el.codeBox.innerHTML = [...state.code].map((c) => `<span class="digit">${c}</span>`).join('');
  el.joinUrl.textContent = location.host;
  el.playersChip.textContent = `${state.players.length} singer${state.players.length === 1 ? '' : 's'}`;
  el.armWinAt.textContent = state.settings.winAt;  el.winAt.value = String(state.settings.winAt);

  const slots = Math.max(2, state.players.length);
  el.lobbyPlayers.innerHTML = Array.from({ length: slots }, (_, i) => {
    const p = state.players[i];
    const c = colorFor(i);
    if (!p) return `<div class="slot"><span class="label">Phone ${i + 1}</span><span class="sn muted">waiting…</span></div>`;
    return `<div class="slot filled" style="border-color:${c}">
      <span class="label" style="color:${p.micOk ? 'var(--p5)' : 'var(--p1)'}">${p.micOk ? 'mic armed' : 'no mic yet'}</span>
      <span class="sn">${escape_(p.name)}</span>
      <span class="sp" style="color:${c}">${p.points}</span>
    </div>`;
  }).join('');

  const view = phase === 'champion' ? 'champ'
    : phase === 'reveal' ? 'reveal'
    : phase === 'live' || phase === 'countdown' ? 'live'
    : phase === 'armed' ? 'armed'
    : 'lobby';
  for (const [k, node] of Object.entries(el.views)) node.classList.toggle('hide', k !== view);

  if (phase === 'loading') {
    el.searchHint.classList.remove('hide');
    el.searchHint.textContent = 'Finding the lyrics…';
  }

  if (view === 'armed') renderArmed();
  if (view === 'live') renderLive();
  if (view === 'reveal' && state.roundNo !== lastRoundNo) { lastRoundNo = state.roundNo; renderReveal(); }
  if (view === 'reveal') renderRevealRows();
  if (view === 'champ' && lastPhase !== 'champion') renderChampion();

  if (phase === 'live' && lastPhase !== 'live') startClock();
  if (phase !== 'live' && lastPhase === 'live') stopClock();
  lastPhase = phase;
}

function renderArmed() {
  const t = state.track || {};
  el.armArt.src = t.art || '';
  el.armArt.classList.toggle('hide', !t.art);
  el.armTitle.textContent = t.name || '—';
  el.armArtist.textContent = t.artist || '—';
  el.armRound.textContent = state.roundNo + 1;
  el.armWindow.textContent = MANUAL
    ? `Start the track from the top on SING - the whole song, ${mmss(state.roundMs)}, ${state.lineCount} lines`
    : `The whole song - ${mmss(state.roundMs)}, ${state.lineCount} lines of lyrics`;
  const ready = state.players.filter((p) => p.micOk).length;
  el.readyCount.textContent = `${ready} / ${state.players.length}`;
  el.goBtn.disabled = state.players.length === 0 || (!MANUAL && !sp.playerReady());
}

function renderLive() {
  const t = state.track || {};
  el.liveTitle.textContent = t.name || '—';
  el.liveArtist.textContent = t.artist || '—';
  const n = state.players.length;
  el.arena.className = 'arena ' + (n <= 1 ? 'solo' : n === 2 ? 'duo' : 'many');

  const top = Math.max(0, ...state.players.map((p) => p.percent));
  el.arena.innerHTML = state.players.map((p) => {
    const c = colorFor(p.slot);
    const lead = p.percent > 0 && p.percent === top;
    return `<div class="lane ${lead ? 'lead' : ''} ${p.connected ? '' : 'dim'}" style="--c:${c}">
      <div class="fill" style="height:${p.percent}%"></div>
      <div class="laneTop">
        <div class="row" style="gap:8px;align-items:center">
          <span class="dot ${p.micOk ? 'on' : ''}"></span>
          <span class="label" style="color:${c}">${p.hits} / ${p.total || 0} words · run ${p.phrase}</span>
        </div>
        <div class="pname">${escape_(p.name)}</div>
        <div class="ppts">${p.points}</div>
      </div>
      <div class="ppct">${p.percent}<span style="font-size:.45em">%</span></div>
    </div>`;
  }).join('');
  if (state.players.length === 2) {
    const vs = document.createElement('div');
    vs.className = 'vs';
    vs.textContent = 'VS';
    el.arena.appendChild(vs);
  }
}

let clockRaf = 0;
function startClock() {
  const loop = () => {
    if (!state?.endsAt) { clockRaf = requestAnimationFrame(loop); return; }
    const left = Math.max(0, state.endsAt - (Date.now() + clockSkew));
    el.clock.textContent = clockText(left);
    el.timeBar.style.width = (100 * left / Math.max(1, state.roundMs)).toFixed(2) + '%';
    el.clock.style.color = left < 15000 ? 'var(--p1)' : '';
    clockRaf = requestAnimationFrame(loop);
  };
  cancelAnimationFrame(clockRaf);
  clockRaf = requestAnimationFrame(loop);
}
function stopClock() { cancelAnimationFrame(clockRaf); clockRaf = 0; }

let clockSkew = 0;   // serverNow - clientNow, keeps the timer honest
setInterval(() => { if (state?.serverNow) clockSkew = state.serverNow - Date.now(); }, 2000);

function renderReveal() {
  const r = state.result;
  if (!r) return;
  el.revRound.textContent = r.roundNo;
  const win = r.rows.find((x) => x.id === r.winnerId);
  el.revStamp.textContent = r.tie ? 'DEAD HEAT' : win ? `${win.name} takes it` : 'Nobody sang';
  el.revStamp.style.color = win ? colorFor(win.slot) : 'var(--mute)';
  el.revStamp.style.animation = 'none'; void el.revStamp.offsetWidth; el.revStamp.style.animation = '';
  el.revLyrics.innerHTML = (r.lineText || []).map((l) => `<div>${escape_(l)}</div>`).join('') || '<span class="muted">—</span>';
  shake(document.querySelector('.stage'));
  if (win) confetti([colorFor(win.slot), '#ffffff', 'var(--acid)'.replace('var(--acid)', '#ffe600')], 120);
}

function renderRevealRows() {
  const r = state.result;
  if (!r) return;
  el.revRows.innerHTML = r.rows.map((row) => {
    const c = colorFor(row.slot);
    const pts = state.players.find((p) => p.id === row.id)?.points ?? 0;
    return `<div class="panel" style="padding:12px 16px;border-color:${row.id === r.winnerId ? c : 'var(--line)'}">
      <div class="row" style="gap:14px;align-items:baseline">
        <span class="d3" style="color:${c};min-width:5ch">${row.percent}%</span>
        <span class="grow" style="font-weight:700;font-size:18px">${escape_(row.name)}</span>
        <span class="label">${row.hits}/${row.total} words · best run ${row.phrase}</span>
        <span class="d3">${pts}</span>
      </div>
      <div style="height:6px;background:var(--line);margin-top:8px">
        <div style="height:100%;width:${row.percent}%;background:${c};transition:width .6s cubic-bezier(.2,.9,.2,1)"></div>
      </div>
    </div>`;
  }).join('');
}

function renderChampion() {
  const r = state.result;
  const champ = state.players.find((p) => p.id === r?.championId);
  $('#champName').textContent = champ ? champ.name.toUpperCase() : 'WINNER';
  $('#champName').style.color = champ ? colorFor(champ.slot) : 'var(--acid)';
  $('#champLine').textContent = champ ? `${champ.points} rounds. Undisputed.` : '';
  confetti(undefined, 260);
  setTimeout(() => confetti(undefined, 180), 500);
}
