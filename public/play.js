// ---------------------------------------------------------------------------
// SYNC — the phone. Owns the microphone and the on-device speech recogniser.
//
// The recogniser is armed ONCE, by a real tap, and then kept alive for the
// whole session by restarting it whenever the browser decides to stop it.
// That matters on iOS, where you only get to call start() inside a gesture.
// ---------------------------------------------------------------------------

import { $, colorFor, connect, confetti, shake } from '/lib.js';

const params = new URLSearchParams(location.search);
const code = (params.get('code') || '').toUpperCase();
const name = params.get('name') || localStorage.getItem('sync:name') || 'Singer';
if (!code) location.href = '/';

const el = {
  roomChip: $('#roomChip'), ptsChip: $('#ptsChip'), hiName: $('#hiName'),
  armMic: $('#armMic'), armBtn: $('#armBtn'), micErr: $('#micErr'),
  waiting: $('#waiting'), waitTitle: $('#waitTitle'), waitSub: $('#waitSub'), board: $('#board'),
  singing: $('#singing'), meter: $('#meter'), meterFill: $('#meterFill'), meterNum: $('#meterNum'),
  words: $('#words'), pClock: $('#pClock'),
  result: $('#result'), resStamp: $('#resStamp'), resPct: $('#resPct'), resDetail: $('#resDetail'),
};

let net = null;
let state = null;
let me = null;
let armed = false;
let lang = 'en-US';
let lastPhase = null;
let clockSkew = 0;

el.roomChip.textContent = code;
el.hiName.textContent = name;

/* --- speech ------------------------------------------------------------- */
// Two engines:
//  - 'groq'    (default when the server has a GROQ_API_KEY): the phone records
//               ~8s clips and uploads them; Whisper on the server transcribes.
//               Much better than the browser for Spanish and other languages.
//  - 'browser' fallback: the browser's own SpeechRecognition, as before.
const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const CLIP_MS = 8000;
let engine = null;              // 'groq' | 'browser', decided on arm
let sttMode = 'browser';        // what the server offers, from /api/config
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
    // no-speech / aborted / network all fall through to onend, which restarts
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
  try { rec.start(); }
  catch { /* already running or still starting; onend will retry */ }
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

// Record one self-contained clip, upload it, and immediately start the next.
// A fresh MediaRecorder per clip guarantees every upload is a complete file.
function recordClip() {
  if (!recording) return;
  let s;
  try { s = stream; if (!s) throw new Error('no stream'); } catch { return; }
  const mime = pickMime();
  let r;
  try { r = mime ? new MediaRecorder(s, { mimeType: mime }) : new MediaRecorder(s); }
  catch (e) { console.warn('recorder', e); return; }
  const parts = [];
  const mySeq = seq++;
  const myRound = clipRound;
  r.ondataavailable = (e) => { if (e.data && e.data.size) parts.push(e.data); };
  r.onstop = () => {
    const blob = new Blob(parts, { type: r.mimeType || mime || 'audio/webm' });
    upload(blob, mySeq, myRound);
  };
  recorder = r;
  r.start();
  clipTimer = setTimeout(() => {
    try { if (r.state !== 'inactive') r.stop(); } catch {}
    recordClip();
  }, CLIP_MS);
}

async function upload(blob, clipSeq, roundNo) {
  if (blob.size < 200 || !me) return;
  const qs = new URLSearchParams({ code, pid: me.id, round: String(roundNo), seq: String(clipSeq) });
  try {
    const res = await fetch('/api/transcribe?' + qs, {
      method: 'POST',
      headers: { 'Content-Type': blob.type || 'audio/webm' },
      body: blob,
    });
    if (!res.ok) console.warn('[stt] clip', clipSeq, res.status);
  } catch (e) {
    console.warn('[stt] upload failed', e);
  }
}

async function startRecording() {
  if (engine !== 'groq' || recording || !state) return;
  try { await ensureStream(); } catch { return fail('Lost the microphone. Tap to re-arm.'); }
  recording = true;
  seq = 0;
  clipRound = state.roundNo;
  recordClip();
}

function stopRecording() {
  if (!recording) return;
  recording = false;
  clearTimeout(clipTimer);
  // The last partial clip still uploads; the server ignores it if the round is over.
  try { if (recorder && recorder.state !== 'inactive') recorder.stop(); } catch {}
  recorder = null;
}

/* --- arming --- */
async function arm() {
  if (arming || armed) return;
  arming = true;
  el.armBtn.disabled = true;
  el.armBtn.textContent = 'Arming…';
  el.micErr.textContent = '';
  try {
    await cfgReady;
    const canGroq = sttMode === 'groq' && pickMime() !== null;
    if (!canGroq && !SR) {
      return fail('This browser can\'t do speech recognition. Use Chrome on Android, or Safari on iOS 16+.');
    }
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
      // The browser recogniser opens its own mic; release ours.
      stream.getTracks().forEach((t) => t.stop());
      stream = null;
      engine = 'browser';
      rec = buildRecogniser();
    }
    alive = true;
    armed = true;
    kick();
    net?.send({ t: 'player:mic', ok: true, engine });
    keepAwake();
    if (state?.phase === 'live') startRecording();
    render();
  } finally {
    arming = false;
    el.armBtn.disabled = false;
    el.armBtn.textContent = 'Arm my mic';
  }
}

function fail(msg) {
  el.micErr.textContent = msg;
  net?.send({ t: 'player:mic', ok: false, engine: engine || 'none' });
}

let heardTimer = 0;
function pushHeard(text) {
  if (state?.phase !== 'live') return;
  clearTimeout(heardTimer);
  // A whole-track round means four minutes of transcript, so send a little
  // less often than we would for a short burst.
  heardTimer = setTimeout(() => net?.send({ t: 'player:heard', text }), 320);
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

// If this site already has mic permission (Chrome remembers it), arm straight
// away instead of making people tap again. Safari usually reports 'prompt',
// so iPhones still get the button, which is what Safari needs anyway.
cfgReady.then(async () => {
  if (sttMode !== 'groq') return;           // the browser engine needs a real tap on iOS
  try {
    const p = await navigator.permissions?.query({ name: 'microphone' });
    if (p?.state === 'granted') arm();
  } catch { /* permissions API not available: keep the button */ }
});

/* --- socket -------------------------------------------------------------- */
net = connect({
  onOpen: (api) => api.send({
    t: 'join', code, name,
    playerId: sessionStorage.getItem('sync:pid:' + code) || undefined,
  }),
  onMessage: handle,
  onDrop: () => { el.roomChip.textContent = '...'; },
});

function handle(msg) {
  switch (msg.t) {
    case 'welcome':
      sessionStorage.setItem('sync:pid:' + code, msg.playerId);
      el.roomChip.textContent = code;
      document.documentElement.style.setProperty('--c', colorFor(msg.slot));
      if (armed) net.send({ t: 'player:mic', ok: true, engine: 'rearmed' });
      break;

    case 'state': {
      state = msg.room;
      me = state.players.find((p) => p.id === msg.you) || null;
      if (state.settings.lang !== lang) {
        lang = state.settings.lang;
        if (rec) { rec.lang = lang; try { rec.stop(); } catch {} }  // onend restarts it
      }
      if (state.phase === 'live') startRecording();
      else stopRecording();
      render();
      break;
    }

    case 'you':
      paintMeter(msg.percent, msg.matched || []);
      break;

    case 'fx':
      if (msg.kind === 'countdown') { finals = ''; el.words.innerHTML = ''; paintMeter(0, []); }
      if (msg.kind === 'go') { shake(document.body, 300); if (alive) kick(); }
      break;

    case 'error':
      if (msg.reason === 'no-room') { alert('That room is gone.'); location.href = '/'; }
      if (msg.reason === 'room-full') { alert('That room is full.'); location.href = '/'; }
      break;
  }
}

/* --- render -------------------------------------------------------------- */
function show(which) {
  for (const k of ['armMic', 'waiting', 'singing', 'result']) {
    el[k].classList.toggle('hide', k !== which);
  }
}

function render() {
  if (!state) return;
  el.ptsChip.textContent = String(me?.points ?? 0);

  el.board.innerHTML = state.players.map((p) => `
    <div class="row" style="gap:10px;border-left:4px solid ${colorFor(p.slot)};padding:6px 10px;background:var(--ink-2)">
      <span class="grow" style="font-weight:700">${p.name}${p.id === me?.id ? ' (you)' : ''}</span>
      <span class="label" style="color:${p.micOk ? 'var(--p5)' : 'var(--p1)'}">${p.micOk ? 'mic on' : 'no mic'}</span>
      <span class="d3">${p.points}</span>
    </div>`).join('');

  if (!armed) { show('armMic'); lastPhase = state.phase; return; }

  const phase = state.phase;
  if (phase === 'live') {
    show('singing');
    startClock();
  } else if (phase === 'reveal' || phase === 'champion') {
    show('result');
    stopClock();
    if (lastPhase !== phase) paintResult();
  } else {
    show('waiting');
    stopClock();
    el.waitTitle.textContent =
      phase === 'armed' ? 'Song locked in' :
      phase === 'countdown' ? 'Here it comes' :
      phase === 'loading' ? 'Loading lyrics' : 'Waiting for the host';
    el.waitSub.textContent =
      phase === 'armed' && state.track ? `${state.track.name} - ${state.track.artist}` :
      'Look at the big screen.';
  }
  lastPhase = phase;
}

function paintMeter(percent, matched) {
  const rose = percent > Number(el.meterNum.textContent || 0);
  el.meterFill.style.height = percent + '%';
  el.meterNum.textContent = percent;
  if (rose) {
    el.meterNum.classList.remove('bump');
    void el.meterNum.offsetWidth;
    el.meterNum.classList.add('bump');
  }
  const hint = document.getElementById('wordsHint');
  if (hint) hint.classList.toggle('hide', (matched?.length || 0) > 0);
  const have = new Set([...el.words.children].map((n) => n.textContent));
  for (const w of matched) {
    if (have.has(w)) continue;
    const s = document.createElement('span');
    s.className = 'hit';
    s.textContent = w;
    el.words.appendChild(s);
    have.add(w);
  }
  while (el.words.children.length > 40) el.words.removeChild(el.words.firstChild);
}

let raf = 0;
function startClock() {
  if (raf) return;
  const loop = () => {
    if (state?.endsAt) {
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

function paintResult() {
  const r = state.result;
  if (!r || !me) return;
  const mine = r.rows.find((x) => x.id === me.id);
  const won = r.winnerId === me.id;
  const champ = r.championId === me.id;
  el.resStamp.textContent = champ ? 'CHAMPION' : won ? 'POINT' : r.tie ? 'TIED' : 'LOST IT';
  el.resStamp.style.color = won || champ ? colorFor(me.slot) : 'var(--mute)';
  el.resPct.textContent = (mine?.percent ?? 0) + '%';
  el.resDetail.textContent = `${mine?.hits ?? 0} of ${mine?.total ?? 0} words · best run ${mine?.phrase ?? 0}`;
  if (won || champ) confetti([colorFor(me.slot), '#ffffff', '#ffe600'], champ ? 220 : 110);
  else shake(document.body, 300);
}
