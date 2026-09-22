// ---------------------------------------------------------------------------
// SYNG — the phone. One phone per team: it holds the team's member list, picks
// songs when it is the team's turn, and records whoever is singing.
// ---------------------------------------------------------------------------

import { $, colorFor, connect, confetti, shake, ordinal } from '/lib.js';

const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
if (!code) location.href = '/';

const store = {
  get(k, d) { try { const v = localStorage.getItem('syng:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('syng:' + k, JSON.stringify(v)); } catch {} },
};

const el = {
  roomChip: $('#roomChip'), ptsChip: $('#ptsChip'),
  teamName: $('#teamName'), memberList: $('#memberList'), memberCount: $('#memberCount'),
  addForm: $('#addForm'), newMember: $('#newMember'), teamErr: $('#teamErr'),
  armBtn: $('#armBtn'), armBtn2: $('#armBtn2'), micOkLine: $('#micOkLine'), micErr: $('#micErr'), micErr2: $('#micErr2'), armTeam: $('#armTeam'),
  chooseTitle: $('#chooseTitle'), chooseSub: $('#chooseSub'), chooseList: $('#chooseList'),
  waitTitle: $('#waitTitle'), waitSub: $('#waitSub'), board: $('#board'),
  singerName: $('#singerName'), annSong: $('#annSong'),
  singWho: $('#singWho'), pClock: $('#pClock'), meterFill: $('#meterFill'), meterNum: $('#meterNum'), singHint: $('#singHint'),
  resStamp: $('#resStamp'), resPct: $('#resPct'), resGain: $('#resGain'), resDetail: $('#resDetail'),
  finStamp: $('#finStamp'), finPts: $('#finPts'),
  screens: {
    team: $('#scrTeam'), arm: $('#scrArm'), choose: $('#scrChoose'), wait: $('#scrWait'), announce: $('#scrAnnounce'),
    sing: $('#scrSing'), scoring: $('#scrScoring'), result: $('#scrResult'), final: $('#scrFinal'),
  },
};

let net = null;
let state = null;
let me = null;
let armed = false;
let lang = 'en-US';
let lastPhase = null;
let lastResultRound = -1;
let finalShown = false;
let clockSkew = 0;

// The team travels with the phone between games.
let teamName = params.get('team') || store.get('team', '') || 'Team';
let members = store.get('members', []);
if (!Array.isArray(members)) members = [];
el.roomChip.textContent = code;

const escape_ = (s) => String(s ?? '').replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));

/* --- team editor --------------------------------------------------------- */
el.teamName.value = teamName;
paintMembers();

function paintMembers() {
  el.memberCount.textContent = members.length ? `${members.length}` : '';
  el.memberList.innerHTML = members.length
    ? members.map((m, i) => `<span class="mchip">${escape_(m)}<button type="button" data-i="${i}" aria-label="Remove ${escape_(m)}">✕</button></span>`).join('')
    : '<span class="muted" style="font-size:14px">Add everyone who might sing for your team — even if it is just you.</span>';
}

let infoTimer = 0;
function saveTeam() {
  store.set('team', teamName);
  store.set('members', members);
  clearTimeout(infoTimer);
  infoTimer = setTimeout(() => net?.send({ t: 'team:info', name: teamName, members: members.length ? members : [teamName] }), 250);
}

el.teamName.addEventListener('input', () => { teamName = el.teamName.value.trim() || 'Team'; saveTeam(); });
el.addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const n = el.newMember.value.replace(/\s+/g, ' ').trim().slice(0, 20);
  el.teamErr.textContent = '';
  if (!n) return;
  if (members.some((m) => m.toLowerCase() === n.toLowerCase())) { el.teamErr.textContent = 'Already on the team'; return; }
  if (members.length >= 30) { el.teamErr.textContent = '30 singers is the limit'; return; }
  members.push(n);
  el.newMember.value = '';
  paintMembers();
  saveTeam();
});
el.memberList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-i]');
  if (!b) return;
  members.splice(Number(b.dataset.i), 1);
  paintMembers();
  saveTeam();
});

/* --- speech -------------------------------------------------------------- */
// Two engines:
//  - 'groq'    (default when the server has a GROQ_API_KEY): the phone records
//               15–34 s clips and uploads them; Whisper on the server transcribes.
//               Longer clips give Whisper more context, so fewer wrong words.
//  - 'browser' fallback: the browser's own SpeechRecognition.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
// Clip length comes from the server (state.clipMs): 15 s for up to four teams,
// longer with more phones so all of them together stay under Groq's 20/min.
const CLIP_MS = 15000;
const clipMs = () => Math.max(CLIP_MS, Number(state?.clipMs) || 0);
let engine = null;
let sttMode = 'browser';
let rec = null;
let finals = '';
let alive = false;
let restartTimer = 0;
let arming = false;

const cfgReady = fetch('/api/config').then((r) => r.json())
  .then((c) => { sttMode = c.stt || 'browser'; })
  .catch(() => {});

function buildRecogniser() {
  const r = new SR();
  r.continuous = true;
  r.interimResults = true;
  r.lang = lang;
  r.maxAlternatives = 1;
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const res = e.results[i];
      if (res.isFinal) finals += ' ' + res[0].transcript;
      else interim += ' ' + res[0].transcript;
    }
    pushHeard(finals + ' ' + interim);
  };
  r.onerror = (e) => {
    if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
      alive = false;
      armed = false;
      fail('Microphone blocked. Allow it in your browser settings, then reload.');
      render();
    }
  };
  r.onend = () => {
    if (!alive) return;
    clearTimeout(restartTimer);
    restartTimer = setTimeout(kick, 140);
  };
  return r;
}

function kick() {
  if (!alive || engine !== 'browser') return;
  try { rec.start(); } catch { /* already running; onend will retry */ }
}

/* --- groq clip recorder --- */
let stream = null;
let recorder = null;
let clipTimer = 0;
let seq = 0;
let clipRound = -1;
let recording = false;

function pickMime() {
  if (!window.MediaRecorder) return null;
  const options = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  if (!MediaRecorder.isTypeSupported) return '';
  return options.find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
}

async function ensureStream() {
  if (stream && stream.getAudioTracks().some((t) => t.readyState === 'live')) return stream;
  stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
  });
  return stream;
}

// One self-contained clip at a time; a fresh MediaRecorder per clip keeps every
// upload a complete file Whisper can read.
function recordClip() {
  if (!recording || !stream) return;
  const mime = pickMime();
  let r;
  try { r = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream); }
  catch (e) { console.warn('recorder', e); return; }
  const parts = [];
  const mySeq = seq++;
  const myRound = clipRound;
  r.isFinal = false;
  r.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  r.onstop = () => upload(new Blob(parts, { type: r.mimeType || mime || 'audio/webm' }), mySeq, myRound, r.isFinal);
  recorder = r;
  r.start();
  clipTimer = setTimeout(() => {
    if (!recording) return;
    try { if (r.state !== 'inactive') r.stop(); } catch {}
    recordClip();
  }, clipMs());
}

async function upload(blob, clipSeq, roundNo, final) {
  if (!me || (!final && blob.size < 200)) return;
  const qs = new URLSearchParams({ code, pid: me.id, round: String(roundNo), seq: String(clipSeq), final: final ? '1' : '0' });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch('/api/transcribe?' + qs, {
        method: 'POST',
        headers: { 'Content-Type': blob.type || 'audio/webm' },
        body: blob,
      });
      if (res.ok || res.status < 500) return;
    } catch (e) {
      console.warn('[stt] upload failed', e);
    }
    await new Promise((r) => setTimeout(r, 800));
  }
}

async function startRecording() {
  if (engine !== 'groq' || recording || !state) return;
  try { await ensureStream(); } catch { return fail('Lost the microphone. Reload and arm it again.'); }
  recording = true;
  seq = 0;
  clipRound = state.roundNo;
  recordClip();
}

/** The song is over: the clip in progress goes up as the final one. */
function stopRecording() {
  if (!recording) return;
  recording = false;
  clearTimeout(clipTimer);
  try {
    if (recorder && recorder.state !== 'inactive') { recorder.isFinal = true; recorder.stop(); }
  } catch {}
  recorder = null;
}

async function arm() {
  if (arming || armed) return;
  arming = true;
  for (const b of [el.armBtn, el.armBtn2]) { b.disabled = true; b.textContent = 'Arming…'; }
  el.micErr.textContent = el.micErr2.textContent = '';
  try {
    await cfgReady;
    const canGroq = sttMode === 'groq' && pickMime() !== null;
    if (!canGroq && !SR) return fail('This browser can\'t do speech recognition. Use Chrome on Android, or Safari on iOS 16+.');
    try {
      await ensureStream();
    } catch (e) {
      return fail(e?.name === 'NotAllowedError'
        ? 'Microphone blocked. Allow it for this site in your browser settings, then tap again.'
        : 'Could not open the microphone: ' + (e?.message || e));
    }
    if (canGroq) {
      engine = 'groq';
    } else {
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      engine = 'browser';
      rec = buildRecogniser();
    }
    alive = true;
    armed = true;
    kick();
    net?.send({ t: 'team:mic', ok: true, engine });
    keepAwake();
    if (state?.phase === 'live') startRecording();
    render();
  } finally {
    arming = false;
    for (const b of [el.armBtn, el.armBtn2]) { b.disabled = false; b.textContent = 'Arm the mic'; }
  }
}

function fail(msg) {
  el.micErr.textContent = el.micErr2.textContent = msg;
  net?.send({ t: 'team:mic', ok: false, engine: engine || 'none' });
}

let heardTimer = 0;
function pushHeard(text) {
  if (state?.phase !== 'live') return;
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => net?.send({ t: 'team:heard', text }), 320);
}

let wakeHooked = false;
async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch {}
  if (wakeHooked) return;
  wakeHooked = true;
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    try { await navigator.wakeLock?.request('screen'); } catch {}
    if (alive) kick();
  });
}

el.armBtn.addEventListener('click', arm);
el.armBtn2.addEventListener('click', arm);

// Chrome remembers mic permission: if it is already granted, arm straight away.
cfgReady.then(async () => {
  if (sttMode !== 'groq') return;           // the browser engine needs a real tap on iOS
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' });
    if (p?.state === 'granted') arm();
  } catch { /* keep the button */ }
});

/* --- socket -------------------------------------------------------------- */
net = connect({
  onOpen: (api) => api.send({
    t: 'join', code, name: teamName, members: members.length ? members : [teamName],
    teamId: sessionStorage.getItem('syng:tid:' + code) || undefined,
  }),
  onMessage: handle,
  onDrop: () => { el.roomChip.textContent = '...'; },
});

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      sessionStorage.setItem('syng:tid:' + code, msg.teamId);
      el.roomChip.textContent = code;
      document.documentElement.style.setProperty('--c', colorFor(msg.slot));
      if (armed) net.send({ t: 'team:mic', ok: true, engine });
      break;

    case 'state': {
      state = msg.room;
      me = state.teams.find((t) => t.id === msg.you) || null;
      if (me) document.documentElement.style.setProperty('--c', colorFor(me.slot));
      if (state.settings.lang !== lang) {
        lang = state.settings.lang;
        if (rec) { rec.lang = lang; try { rec.stop(); } catch {} }
      }
      if (state.phase === 'live') startRecording();
      else stopRecording();
      render();
      break;
    }

    case 'fx':
      if (msg.kind === 'countdown') { finals = ''; paintMeter(0); }
      if (msg.kind === 'go') { shake(document.body, 300); if (alive) kick(); }
      if (msg.kind === 'singers' && me && msg.singers?.[me.id]) {
        shake(document.body, 400);
      }
      break;

    case 'error': {
      const why = {
        'no-room': 'That room is gone.',
        'room-full': 'That room is full (ten teams is the limit).',
        'game-running': 'That game has already started. Ask the host to start a new one.',
        kicked: 'The host removed your team.',
      }[msg.reason];
      if (why) {
        sessionStorage.removeItem('syng:tid:' + code);
        net.close();
        location.href = '/?msg=' + encodeURIComponent(why);
      }
      break;
    }
  }
}

/* --- render -------------------------------------------------------------- */
function show(which) {
  for (const [k, node] of Object.entries(el.screens)) node.classList.toggle('hide', k !== which);
}

function render() {
  if (!state || !me) return;
  const phase = state.phase;
  el.ptsChip.textContent = `${me.points} pts`;
  for (const n of document.querySelectorAll('.rNo')) n.textContent = state.roundNo;
  for (const n of document.querySelectorAll('.rOf')) n.textContent = state.settings.rounds;

  if (phase !== 'final') finalShown = false;
  if (phase === 'setup') {
    show('team');
    el.armBtn.classList.toggle('hide', armed);
    el.micOkLine.classList.toggle('hide', !armed);
    if (document.activeElement !== el.teamName) el.teamName.value = me.name;
    lastPhase = phase;
    return;
  }
  if (!armed) {
    el.armTeam.textContent = me.name;
    show('arm');
    lastPhase = phase;
    return;
  }

  const singer = state.singers?.[me.id];
  if (phase === 'choosing') {
    const mine = state.chooserId === me.id;
    const chooser = state.teams.find((t) => t.id === state.chooserId);
    el.chooseTitle.textContent = mine ? 'Your pick!' : `${chooser?.name || 'Another team'} is picking`;
    el.chooseSub.textContent = mine ? 'Choose the song everyone sings' : 'Here is what they can choose from';
    el.chooseList.innerHTML = state.options
      ? state.options.map((o, i) => `
          <button class="optCard phoneOpt" data-idx="${i}" ${mine ? '' : 'disabled'} style="--c:${colorFor(i + 1)}">
            <span class="oYear">${o.year || ''}</span>
            <span class="oTitle">${escape_(o.title)}</span>
            <span class="oArtist">${escape_(o.artist)}</span>
          </button>`).join('')
      : `<div class="muted">${state.optionsError ? escape_(state.optionsError) : 'Shuffling the jukebox…'}</div>`;
    show('choose');
  } else if (phase === 'pick' || phase === 'loading' || phase === 'singers') {
    el.waitTitle.textContent = phase === 'singers' ? 'Picking the singers' : 'The game master is picking a song';
    el.waitSub.textContent = 'Look at the big screen.';
    paintBoard();
    show('wait');
  } else if (phase === 'armed') {
    el.singerName.textContent = singer || '—';
    el.annSong.textContent = state.track ? `${state.track.name} — ${state.track.artist}` : '';
    show('announce');
  } else if (phase === 'countdown' || phase === 'live') {
    el.singWho.textContent = singer ? `${singer} — sing!` : 'Sing!';
    el.singHint.textContent = phase === 'countdown' ? 'Get ready…' : 'Keep the phone close to your mouth';
    paintMeter(me.percent);
    show('sing');
    startClock();
  } else if (phase === 'scoring') {
    stopClock();
    show('scoring');
  } else if (phase === 'reveal') {
    stopClock();
    paintResult();
    show('result');
  } else if (phase === 'final') {
    paintFinal();
    show('final');
  }
  lastPhase = phase;
}

function paintBoard() {
  el.board.innerHTML = [...state.teams].sort((a, b) => b.points - a.points).map((t) => `
    <div class="row" style="gap:10px;border-left:4px solid ${colorFor(t.slot)};padding:6px 10px;background:var(--ink-2)">
      <span class="grow" style="font-weight:700">${escape_(t.name)}${t.id === me?.id ? ' (you)' : ''}</span>
      <span class="d3">${t.points}</span>
    </div>`).join('');
}

el.chooseList.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-idx]');
  if (!b || b.disabled) return;
  for (const x of el.chooseList.querySelectorAll('button')) x.disabled = true;
  b.classList.add('picked');
  net.send({ t: 'team:choose', idx: Number(b.dataset.idx) });
});

function paintMeter(percent) {
  const p = Number(percent) || 0;
  const rose = p > Number(el.meterNum.textContent || 0);
  el.meterFill.style.height = p + '%';
  el.meterNum.textContent = p;
  if (rose) {
    el.meterNum.classList.remove('bump');
    void el.meterNum.offsetWidth;
    el.meterNum.classList.add('bump');
  }
}

let raf = 0;
function startClock() {
  if (raf) return;
  const loop = () => {
    if (state?.endsAt && state.phase === 'live') {
      const left = Math.max(0, state.endsAt - (Date.now() + clockSkew));
      const secs = Math.ceil(left / 1000);
      el.pClock.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
}
function stopClock() { cancelAnimationFrame(raf); raf = 0; }
setInterval(() => { if (state?.serverNow) clockSkew = state.serverNow - Date.now(); }, 2000);

const ORD = { get: (i) => ordinal(i + 1) };
function paintResult() {
  const r = state.result;
  if (!r) return;
  const i = r.rows.findIndex((x) => x.id === me.id);
  const mine = r.rows[i];
  if (!mine) return;
  const place = r.rows.findIndex((x) => x.percent === mine.percent && x.phrase === mine.phrase);
  const tied = r.rows.filter((x) => x.percent === mine.percent && x.phrase === mine.phrase).length > 1;
  const won = r.winnerId === me.id;
  el.resStamp.textContent = won ? 'You take it' : tied && mine.percent > 0 ? `Tied ${ORD.get(place)}` : mine.percent === 0 ? 'Silence' : ORD.get(place);
  el.resStamp.style.color = won ? colorFor(me.slot) : 'var(--mute)';
  el.resPct.textContent = mine.percent + '%';
  el.resGain.textContent = `+${mine.gain} point${mine.gain === 1 ? '' : 's'}`;
  el.resGain.style.color = mine.gain ? 'var(--p5)' : 'var(--mute)';
  el.resDetail.textContent = `${mine.hits} of ${mine.total} words`;
  if (r.roundNo !== lastResultRound) {
    lastResultRound = r.roundNo;
    if (won) confetti([colorFor(me.slot), '#ffffff', '#ffe600'], 110);
    else shake(document.body, 300);
  }
}

function paintFinal() {
  const ranked = [...state.teams].sort((a, b) => b.points - a.points);
  const place = ranked.findIndex((t) => t.points === me.points);
  const tied = ranked.filter((t) => t.points === me.points).length > 1;
  const champ = place === 0 && !tied;
  el.finStamp.textContent = champ ? 'Champions' : tied ? `Tied ${ORD.get(place)}` : ORD.get(place);
  el.finStamp.style.color = champ ? colorFor(me.slot) : 'var(--mute)';
  el.finPts.textContent = `${me.points} points`;
  if (!finalShown) {
    finalShown = true;
    if (champ) { confetti(undefined, 220); setTimeout(() => confetti(undefined, 160), 500); }
  }
}
