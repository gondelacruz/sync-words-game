// ---------------------------------------------------------------------------
// SYNG — guess the language a song is sung in, from its lyric sheet.
//
// Non-Latin scripts are decided by the characters alone. For Latin-script
// languages we count very common words that are distinctive to each language
// ("the", "que", "não", "ich"...) across the whole sheet and take the winner.
// A whole song is a few hundred words, which makes this reliable.
// ---------------------------------------------------------------------------

const WORDS = {
  en: 'the and you i im i\'m my me your it is that what with this dont don\'t cant can\'t we be love baby oh know just like all when are got gonna wanna never',
  es: 'el los las y yo pero cuando quiero porque eres estoy qué más corazón nada sin todo también muy hay así contigo noche mujer eso ella usted tú mí nunca siempre vida',
  pt: 'não você eu pra meu minha isso então coração agora muito vou gente nós só tudo também sem ela mais nunca vida quero amor',
  fr: 'je les et pas ne est c\'est j\'ai moi toi pour dans qui avec mais plus tout suis nous vous oui jamais rien mon ma',
  de: 'ich du und die der das nicht ist mich mir dich dir wir mit auf sie ein eine kein noch doch nur schon heute',
  it: 'il che non sono per ma come sei mio mia tuo io gli della cosa tutto ancora amore cuore perché sempre anche niente',
};

// A few words appear in two lists on purpose (e.g. "sin" / "sem"): scoring is
// relative, so the language with more hits still wins.
const SETS = Object.fromEntries(
  Object.entries(WORDS).map(([k, v]) => [k, new Set(v.split(/\s+/))]),
);

const BCP47 = {
  en: 'en-US', es: 'es-ES', pt: 'pt-BR', fr: 'fr-FR', de: 'de-DE', it: 'it-IT',
  zh: 'zh-CN', ja: 'ja-JP', ko: 'ko-KR', ru: 'ru-RU', ar: 'ar-SA',
};

/**
 * @param {string} text  every lyric line joined together
 * @returns {{ iso: string, bcp47: string }}  e.g. { iso: 'es', bcp47: 'es-ES' }
 */
export function detectLanguage(text) {
  const s = String(text || '');
  const pick = (iso) => ({ iso, bcp47: BCP47[iso] });

  // Script-based languages. Kana before Han: Japanese lyrics also use kanji.
  if (/[぀-ヿ]/.test(s)) return pick('ja');
  if (/[가-힯]/.test(s)) return pick('ko');
  if (/[一-鿿]/.test(s)) return pick('zh');
  if (/[Ѐ-ӿ]/.test(s)) return pick('ru');
  if (/[؀-ۿ]/.test(s)) return pick('ar');

  const tokens = s.toLowerCase().replace(/[’`]/g, "'").match(/[\p{L}']+/gu) || [];
  const counts = Object.fromEntries(Object.keys(SETS).map((k) => [k, 0]));
  for (const t of tokens) {
    for (const [k, set] of Object.entries(SETS)) if (set.has(t)) counts[k]++;
  }
  // Letters only one language uses are a strong tie-breaker.
  counts.es += (s.match(/[ñ¿¡]/g) || []).length * 2;
  counts.pt += (s.match(/[ãõ]/g) || []).length * 2;
  counts.de += (s.match(/[ß]/g) || []).length * 2;

  let best = 'en', top = 0;
  for (const [k, n] of Object.entries(counts)) if (n > top) { best = k; top = n; }
  return pick(best);
}
