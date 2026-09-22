// ---------------------------------------------------------------------------
// Which jukebox songs have NO time-synced lyrics on LRCLIB? (They are skipped
// in the game anyway, so this is only housekeeping.)
//   node scripts/check-songs.js            # every language
//   node scripts/check-songs.js es fr      # just these
// Prints the misses; delete or fix those lines in server/jukebox/*.txt.
// ---------------------------------------------------------------------------

import { SONGS } from '../server/songs.js';
import { findLyrics } from '../server/lyrics.js';

const langs = process.argv.slice(2);
const list = SONGS.filter((s) => !langs.length || langs.includes(s.lang));
const misses = [];
let done = 0;
const queue = [...list];
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    const lyrics = await findLyrics({ title: s.title, artist: s.artist }).catch(() => null);
    if (!lyrics) misses.push(s);
    if (++done % 50 === 0) console.error(`  ${done}/${list.length} checked, ${misses.length} missing`);
  }
}
await Promise.all(Array.from({ length: 4 }, worker));   // be gentle with a free service
console.log(`\n${list.length - misses.length} of ${list.length} songs have synced lyrics. Missing:\n`);
for (const s of misses) console.log(`  [${s.lang}] ${s.artist} | ${s.title} | ${s.year ?? ''}`);
