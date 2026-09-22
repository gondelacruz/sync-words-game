// ---------------------------------------------------------------------------
// Pre-fill server/youtube-ids.json so jukebox songs cost no YouTube search
// during a game. Uses up to N searches (default 90 of the 100/day), so run it
// once a day for a while, then commit server/youtube-ids.json.
//   YOUTUBE_API_KEY=... node scripts/resolve-youtube.js [N] [langs...]
//   e.g. YOUTUBE_API_KEY=... node scripts/resolve-youtube.js 90 en es
// ---------------------------------------------------------------------------

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { SONGS } from '../server/songs.js';
import { findLyrics } from '../server/lyrics.js';
import { findVideos, simplify, ytEnabled } from '../server/youtube.js';

if (!ytEnabled()) { console.error('Set YOUTUBE_API_KEY first.'); process.exit(1); }
const [nArg, ...langs] = process.argv.slice(2);
const budget = Math.max(1, Number(nArg) || 90);
const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'youtube-ids.json');
const have = JSON.parse(readFileSync(file, 'utf8'));
const todo = SONGS.filter((s) => (!langs.length || langs.includes(s.lang)) && !have[`${simplify(s.artist)}|${simplify(s.title)}`]);
console.log(`${todo.length} songs without a video yet; resolving up to ${budget}.`);

let used = 0;
for (const s of todo) {
  if (used >= budget) break;
  const lyrics = await findLyrics({ title: s.title, artist: s.artist }).catch(() => null);
  if (!lyrics) continue;                       // not playable anyway: don't spend a search
  const out = await findVideos({ title: s.title, artist: s.artist, durationMs: lyrics.durationMs });
  if (out.reason === 'quota') { console.log('Quota used up for today.'); break; }
  used += out.cached ? 0 : 1;
  console.log(`${out.ok ? 'ok  ' : 'miss'} ${s.artist} - ${s.title}${out.ok ? '  ->  ' + out.videos[0].title : ''}`);
}
await new Promise((r) => setTimeout(r, 2000));  // let the cache file save
console.log(`\nDone: ${used} searches used. Commit server/youtube-ids.json to keep them.`);
