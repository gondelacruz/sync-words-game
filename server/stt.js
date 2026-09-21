// ---------------------------------------------------------------------------
// SYNG — speech-to-text through Groq's hosted Whisper.
//
// Phones record short self-contained audio clips and POST them to our server;
// the server forwards each clip to Groq. The API key never leaves the server.
//
// Groq free tier (Sept 2026): 20 requests/minute and 7,200 audio-seconds/hour
// per key, and every request is billed as at least 10 seconds. The phones send
// one clip every ~8s, so two phones stay at ~15 requests/minute. A small
// limiter below keeps us under 20/minute even if something goes wrong.
// ---------------------------------------------------------------------------

const BASE = process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1';
const MODEL = process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo';
const PER_MINUTE = 19;

export const sttEnabled = () => Boolean(process.env.GROQ_API_KEY);

// Whisper is known to "hear" these on music or near-silence, especially in
// Spanish. They would otherwise leak common words ("por", "el") into scoring.
const HALLUCINATIONS = [
  /subt[ií]tul/i, /amara\.org/i, /gracias por ver/i, /suscr[ií]b/i,
  /thanks? for watching/i, /please subscribe/i, /sous-titr/i, /untertitel/i,
  /legendas? pela comunidade/i, /sottotitoli/i,
];

const EXT = (mime) =>
  /webm/.test(mime) ? 'webm'
  : /mp4|m4a|aac/.test(mime) ? 'm4a'
  : /ogg/.test(mime) ? 'ogg'
  : /wav/.test(mime) ? 'wav'
  : /mpeg|mp3/.test(mime) ? 'mp3'
  : 'webm';

// Sliding one-minute window shared by every room on this server.
const stamps = [];
async function slot() {
  for (let i = 0; i < 40; i++) {
    const cutoff = Date.now() - 60_000;
    while (stamps.length && stamps[0] < cutoff) stamps.shift();
    if (stamps.length < PER_MINUTE) { stamps.push(Date.now()); return true; }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;                       // waited 10s and still no room: drop it
}

/**
 * @param {Buffer} audio  one self-contained clip (webm / m4a / ogg ...)
 * @param {string} mime   the clip's content type as the phone recorded it
 * @param {string} iso    ISO-639-1 language code, e.g. 'es'
 * @returns {Promise<string>} the words heard, or '' when nothing usable
 */
export async function transcribe(audio, mime, iso) {
  if (!sttEnabled()) throw new Error('GROQ_API_KEY is not set');

  for (let attempt = 0; attempt < 2; attempt++) {
    if (!(await slot())) throw new Error('rate limited locally');

    const form = new FormData();
    form.append('file', new Blob([audio], { type: mime || 'audio/webm' }), `clip.${EXT(mime)}`);
    form.append('model', MODEL);
    form.append('response_format', 'verbose_json');
    form.append('temperature', '0');
    if (iso) form.append('language', iso);

    const res = await fetch(`${BASE}/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });

    if (res.status === 429 && attempt === 0) {
      const wait = Math.min(5, Number(res.headers.get('retry-after')) || 2);
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    if (!res.ok) {
      throw new Error(`groq ${res.status}: ${(await res.text()).slice(0, 300)}`);
    }

    const body = await res.json();
    const segments = Array.isArray(body.segments) ? body.segments : null;
    const text = segments
      ? segments
        .filter((s) => (s.no_speech_prob ?? 0) < 0.6 && (s.avg_logprob ?? 0) > -1.2)
        .map((s) => s.text)
        .join(' ')
      : String(body.text || '');
    return HALLUCINATIONS.some((re) => re.test(text)) ? '' : text.trim();
  }
  return '';
}
