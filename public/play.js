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

/* --- speech (using Groq Whisper) ------------------------------------------ */
let mediaRecorder = null;
let audioChunks = [];
let audioContext = null;
let detectedLanguage = 'en-US';
let alive = false;
let transcriptionInProgress = false;

el.armBtn.addEventListener('click', arm);

function buildRecogniser() {
  // Setup done in arm(); this function is called but mostly empty for compatibility
  return {
    start: () => {},
    stop: () => {},
  };
}

async function transcribeChunk(audioBlob) {
  if (transcriptionInProgress || !alive) return;
  transcriptionInProgress = true;

  try {
    const arrayBuffer = await audioBlob.arrayBuffer();
    const base64Audio = btoa(String.fromCharCode(...new Uint8Array(arrayBuffer)));

    const response = await fetch('/api/transcribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        audio: base64Audio,
        language: detectedLanguage,
      }),
    });

    if (!response.ok) {
      console.error('Transcription error:', await response.text());
      transcriptionInProgress = false;
      return;
    }

    const result = await response.json();
    if (result.text) {
      pushHeard(result.text);
    }
  } catch (error) {
    console.error('Transcription failed:', error);
  } finally {
    transcriptionInProgress = false;
  }
}

async function arm() {
  try {
    // Check if permission is already granted
    let hasPermission = false;
    try {
      const result = await navigator.permissions.query({ name: 'microphone' });
      hasPermission = result.state === 'granted';
    } catch (e) {
      // Permissions API not supported; proceed with getUserMedia
    }

    let stream;
    if (hasPermission) {
      // Permission already granted; use it directly without prompt
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
      });
    } else {
      // First time; request permission with timeout to prevent hanging
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000); // 8 second timeout
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: true },
        });
      } finally {
        clearTimeout(timeout);
      }
    }

    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (event) => {
      audioChunks.push(event.data);
    };

    mediaRecorder.onstop = () => {
      if (!alive) return;
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      audioChunks = [];
      transcribeChunk(audioBlob);
    };

    mediaRecorder.start();
    
    // Transcribe every 2 seconds
    const transcriptionInterval = setInterval(() => {
      if (!alive || !mediaRecorder || mediaRecorder.state === 'stopped') {
        clearInterval(transcriptionInterval);
        return;
      }
      if (audioChunks.length > 0) {
        mediaRecorder.stop();
        mediaRecorder.start();
      }
    }, 2000);

    alive = true;
    armed = true;
    net?.send({ t: 'player:mic', ok: true, engine: 'groq' });
    keepAwake();
    el.micErr.textContent = '';
    render();
  } catch (error) {
    const msg = error.name === 'NotAllowedError'
      ? 'Microphone permission denied.'
      : error.name === 'AbortError'
      ? 'Microphone permission request timed out. Try again.'
      : 'Microphone error: ' + error.message;
    el.micErr.textContent = msg;
    net?.send({ t: 'player:mic', ok: false, engine: 'groq-blocked' });
  }
}

function fail(msg) {
  el.micErr.textContent = msg;
  net?.send({ t: 'player:mic', ok: false, engine: 'groq-error' });
}

let heardTimer = 0;
function pushHeard(text) {
  if (state?.phase !== 'live') return;
  clearTimeout(heardTimer);
  heardTimer = setTimeout(() => net?.send({ t: 'player:heard', text }), 320);
}

async function keepAwake() {
  try { await navigator.wakeLock?.request('screen'); } catch {}
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

/** Detect language from lyrics text (client-side mirror of server function) */
function detectLanguageFromLyrics(lyricsText) {
  if (!lyricsText) return 'en-US';
  
  const text = lyricsText.toLowerCase();
  
  // Chinese (Simplified)
  if (/[一-鿿]/.test(text)) return 'zh-CN';
  
  // Japanese
  if (/[぀-ゟ゠-ヿ]/.test(text)) return 'ja-JP';
  
  // Cyrillic (Russian)
  if (/[Ѐ-ӿ]/.test(text)) return 'ru-RU';
  
  // Arabic
  if (/[؀-ۿ]/.test(text)) return 'ar-SA';
  
  // Spanish
  if (/[áéíóúñüü]/.test(text) || /\b(el|la|de|que|para|por|con|una|uno|este|ese)\b/.test(text)) {
    return 'es-ES';
  }
  
  // French
  if (/[àâäæéèêëïîôùûüœ]/.test(text) || /\b(le|la|de|et|qu|pour|par|une|ce|est)\b/.test(text)) {
    return 'fr-FR';
  }
  
  // German
  if (/[äöüß]/.test(text) || /\b(der|die|das|und|in|zu|den|von|ist|ich)\b/.test(text)) {
    return 'de-DE';
  }
  
  // Portuguese
  if (/[ãõáéíóú]/.test(text) || /\b(o|a|de|que|e|para|em|um|uma|os|as)\b/.test(text)) {
    return 'pt-BR';
  }
  
  // Italian
  if (/\b(il|lo|la|di|da|che|per|un|una|e|o|è)\b/.test(text)) {
    return 'it-IT';
  }
  
  return 'en-US';
}
