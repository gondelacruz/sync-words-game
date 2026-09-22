// ---------------------------------------------------------------------------
// SYNG — the jukebox for Random mode. Famous, sing-along songs from every
// decade, tagged by the language they are sung in.
//
// The songs live in server/jukebox/<lang>.txt (or <lang>-<anything>.txt), one
// per line: "Artist | Title | Year". Edit those files to add or remove songs;
// duplicates are dropped automatically.
//
// Nothing here is trusted blindly: before a song is offered, the server checks
// LRCLIB actually has time-synced lyrics for it, so a missing entry only means
// that song is quietly skipped.
// ---------------------------------------------------------------------------

import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const DIR = join(dirname(fileURLToPath(import.meta.url)), 'jukebox');

export const LANGUAGES = [
  { iso: 'en', name: 'English' },
  { iso: 'es', name: 'Español' },
  { iso: 'pt', name: 'Português' },
  { iso: 'fr', name: 'Français' },
  { iso: 'it', name: 'Italiano' },
  { iso: 'de', name: 'Deutsch' },
];

const simple = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, ' ').trim();

function load() {
  const known = new Set(LANGUAGES.map((l) => l.iso));
  const seen = new Set();
  const out = [];
  for (const file of readdirSync(DIR).filter((f) => f.endsWith('.txt')).sort()) {
    const lang = file.split(/[-.]/)[0];
    if (!known.has(lang)) continue;
    for (const line of readFileSync(join(DIR, file), 'utf8').split('\n')) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const [artist, title, year] = line.split('|').map((x) => x.trim());
      if (!artist || !title) continue;
      const id = `${lang}:${artist}:${title}`.toLowerCase();
      const dupe = `${lang}|${simple(artist)}|${simple(title)}`;
      if (seen.has(dupe)) continue;
      seen.add(dupe);
      out.push({ id, lang, artist, title, year: Number(year) || null });
    }
  }
  return out;
}

export const SONGS = load();

/** Songs in any of the given languages, minus ones already played this game. */
export function pool(langs, exclude = new Set()) {
  const want = new Set((langs && langs.length ? langs : ['en']));
  return SONGS.filter((s) => want.has(s.lang) && !exclude.has(s.id));
}
