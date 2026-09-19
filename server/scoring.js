// ---------------------------------------------------------------------------
// SYNC — text normalisation and sing-off scoring.
// Everything here is pure, so scripts/simulate.js can hammer it directly.
// ---------------------------------------------------------------------------

const COMBINING = /[\u0300-\u036f]/g;
const CJK = /[\u3040-\u30ff\u4e00-\u9fff]/;

/** Lowercase, strip accents and punctuation, squash whitespace. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(COMBINING, '')
    .replace(/['\u2018\u2019`\u00b4]/g, '')      // don't -> dont, rock'n -> rockn
    .replace(/[^a-z0-9\u3040-\u30ff\u4e00-\u9fff\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Split into comparable tokens. Latin scripts split on spaces; CJK splits per
 * character, because speech engines don't agree on word boundaries there.
 */
export function tokenize(text) {
  const n = normalize(text);
  if (!n) return [];
  const out = [];
  for (const chunk of n.split(' ')) {
    if (!chunk) continue;
    if (CJK.test(chunk)) out.push(...Array.from(chunk));
    else out.push(chunk);
  }
  return out;
}

/** Longest run of target tokens the player produced back-to-back, in order. */
function longestPhrase(target, said) {
  if (!target.length || !said.length) return 0;
  let best = 0;
  let prev = new Array(said.length + 1).fill(0);
  for (let i = 1; i <= target.length; i++) {
    const row = new Array(said.length + 1).fill(0);
    for (let j = 1; j <= said.length; j++) {
      if (target[i - 1] === said[j - 1]) {
        row[j] = prev[j - 1] + 1;
        if (row[j] > best) best = row[j];
      }
    }
    prev = row;
  }
  return best;
}

// Above this many DP cells the phrase search costs more than it is worth on a
// small dyno, so live updates reuse the previous value and the final score --
// computed once -- pays for the exact answer.
const PHRASE_BUDGET = 160000;

/**
 * Score a performance.
 *   target — tokens of the lyrics that were actually playing
 *   said   — tokens the phone heard
 *
 * Coverage is a multiset intersection: saying "love" four times only counts
 * for as many "love"s as the song has. Phrase bonus rewards actually knowing
 * a line rather than shotgunning common words.
 *
 * opts.phraseFloor carries the last known phrase length forward when we skip
 * the search; opts.exact forces it regardless of budget.
 */
export function score(target, said, opts = {}) {
  const empty = { percent: 0, hits: 0, total: target.length, phrase: 0, matched: [] };
  if (!target.length || !said.length) return empty;

  const pool = new Map();
  for (const w of target) pool.set(w, (pool.get(w) ?? 0) + 1);

  const matched = [];
  for (const w of said) {
    const left = pool.get(w);
    if (left) {
      pool.set(w, left - 1);
      matched.push(w);
    }
  }

  const hits = matched.length;
  const coverage = hits / target.length;
  const affordable = opts.exact || target.length * said.length <= PHRASE_BUDGET;
  const phrase = affordable ? longestPhrase(target, said) : (opts.phraseFloor || 0);
  // A nailed phrase of 4+ words is worth a nudge, capped so coverage still rules.
  const bonus = Math.min(0.08, Math.max(0, phrase - 3) * 0.02);
  const percent = Math.max(0, Math.min(100, Math.round((coverage + bonus) * 100)));

  return { percent, hits, total: target.length, phrase, matched };
}

/** Which target tokens are still unsung — powers the "you missed" recap. */
export function missed(target, said) {
  const pool = new Map();
  for (const w of said) pool.set(w, (pool.get(w) ?? 0) + 1);
  const out = [];
  for (const w of target) {
    const left = pool.get(w);
    if (left) pool.set(w, left - 1);
    else out.push(w);
  }
  return out;
}
