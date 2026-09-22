# SYNG

A karaoke sing-off for up to **ten teams**. The laptop plays a famous song out
loud, start to finish, in an embedded **YouTube** player (video on the left,
every team's live percentage on the right). Each team has one phone and a list of members; one singer
per team holds the phone to their mouth and sings the whole thing. The server
transcribes every phone (Groq Whisper) and scores it against the real lyrics.

**Two modes**

- **Random hits** — three famous songs from the languages the host ticked
  (English by default, saved on the laptop), drawn from a jukebox of ~3,000
  songs in `server/jukebox/*.txt`. Teams take turns choosing one on
  their phone; one singer per team is drawn at random, and everyone gets a turn
  before anyone sings twice.
- **Game master** — the host searches every song and picks who sings for each
  team, or lets the dice decide.

The host picks 1–30 rounds. Each round, you score one point for every team you
beat (9 / 8 / … / 0 with ten teams). Most points at the end wins, and **Play
again** keeps the same teams.

---

## How a round works

1. The host searches a song and hits **Sing the whole thing**.
2. SYNC pulls the **time-synced** lyrics for that track.
3. Countdown, then the YouTube video plays from the top. The round is the song:
   three minutes, four, however long it runs.
4. Each phone transcribes whatever its owner is bellowing and streams it to the
   server the whole way through.
5. The server compares each transcript against the words that have genuinely
   played so far. Highest percentage at the end takes the point. First to 3 wins.

**The live meter judges you against the song so far, not the whole track.** If it
scored against the full lyric sheet from the first bar, both bars would crawl near
zero for four minutes and nobody could tell who was winning. Instead the
denominator grows line by line as the song plays — so a player who nails the first
verse sits at 100%, and watches it slide if they go quiet in the second. The final
score, when the music stops, is against every word in the track.

The host can cut a round short with **End it here** — useful for the seven-minute
album version somebody inevitably picks.

**Scoring** is a multiset match, so shouting `"love love love love"` at a song
with one `love` in it earns exactly one `love`. There's a small bonus for the
longest unbroken phrase you got right, which rewards actually knowing the line
over machine-gunning common words.

Everyone is re-scored on a shared one-second tick, so both lanes always show the
same denominator and the bars move with the music rather than only when someone
happens to say something.

---

## Setup

You need **Node 20+**. Music comes from YouTube by default; no subscription needed.

### 1. YouTube API key (so the game finds the videos by itself)

1. <https://console.cloud.google.com> → create a project → **APIs & Services →
   Library** → enable **YouTube Data API v3**.
2. **Credentials → Create credentials → API key**. Restrict it to the YouTube
   Data API.
3. Put it in Render's Environment tab as `YOUTUBE_API_KEY` (locally: `.env`).

**Quota.** The free allowance is **100 searches per day per Google Cloud
project**. It is *not* per player or per host: everyone who plays on this
server shares the same 100 a day, wherever they are. It refills at midnight
Pacific time (11:00 in Dubai while the US is on summer time, 12:00 in winter). Each *new*
song costs one search. Matches are remembered in `server/youtube-ids.json`, so a
song that has been played once is free forever after. Game-master search costs
nothing because it searches LRCLIB, not YouTube.
To stretch it:

- `YOUTUBE_API_KEY=... node scripts/resolve-youtube.js 90 en es` pre-fills
  `server/youtube-ids.json` for jukebox songs (90 a day); commit the file so
  Render has them. Render wipes the disk on each deploy, so matches found
  during games there are lost unless you commit them.
- Google has a free "quota extension" form for more.
- When searches run out, the host sees **Search YouTube ↗** and a box to paste a
  link. Pasted links also cost nothing.

Without any key the game still works; the host pastes a link every round.

### 2. Run it

```bash
npm install
npm start
# open http://127.0.0.1:3000
```

Speech-to-text needs `GROQ_API_KEY` (in Render's Environment tab). With more than four phones,
each phone sends longer clips (up to 34 s for ten) so the server stays under
Groq's free 20 requests/minute. The free tier also caps audio at 7,200 seconds
an hour, which is about three 4-minute songs an hour with ten phones. For big
groups, switch Groq to the paid Dev tier (about $0.04 per audio-hour).

**The phones won't work against your laptop's local IP.** Browsers refuse
microphone access on plain `http://` outside localhost. Deploy it, or tunnel it:

```bash
npx cloudflared tunnel --url http://127.0.0.1:3000
```

### 3. Deploy free on Render

`render.yaml` is already here.

1. Push this repo to GitHub.
2. On <https://render.com> → **New → Blueprint** → pick the repo.
3. Set `YOUTUBE_API_KEY` and `GROQ_API_KEY` in the Environment tab.

The free tier sleeps after inactivity, so the first load of the night takes
about thirty seconds. After that it's instant.

---

## Revert to Spotify

The Spotify version is still in the code, working, just switched off. Every
Spotify-only line is marked `[SPOTIFY]` (`public/spotify.js`, `public/host.js`,
`server/index.js`, `server/rooms.js`). To go back:

1. In Render → Environment, add `MUSIC_SOURCE` = `spotify` and redeploy.
   (Or just to try it once: open `/host.html?music=spotify`.)
2. Make sure `SPOTIFY_CLIENT_ID` is set, and that the Spotify app's Redirect
   URIs include `https://<your-app>.onrender.com/host.html`.
3. The host clicks **Connect Spotify** (Premium needed).

Limits: Spotify's Development Mode allows 5 authorised users, and its developer
policy does not allow games. That is why YouTube is now the default. To undo
the revert, delete `MUSIC_SOURCE` (or set it to `youtube`).

### Spotify app setup (only for the rollback)

1. <https://developer.spotify.com/dashboard> → create an app.
2. Redirect URIs: `http://127.0.0.1:3000/host.html` and
   `https://YOUR-APP.onrender.com/host.html`.
3. Tick **Web Playback SDK**, copy the **Client ID** into `SPOTIFY_CLIENT_ID`.

---

## Playing

- **Laptop**: open the site, *Host on this screen*. Before each song you see the
  video preview. If it is the wrong version (live, music video with a long
  intro), click **Wrong video? Next match** or paste a link.
- **Phones** (up to ten): open the same URL, punch in the four-character code,
  tap **Arm my mic** once, and leave the page open.
- Speakers up, headphones off, phone close to your mouth.
- **End it here** stops the music at once.

YouTube's rules: the video must stay visible while it plays and nothing may be
drawn over it. That is why it hides during the countdown and announcements.

### Manual mode

Add `?manual=1` to the host URL and SYNC plays nothing itself. You type the artist and title, it fetches the
lyrics, and *you* start the song from wherever you like — a phone, a record,
YouTube — from `0:00` when the counter says SING. Scoring follows the lyric
timestamps from there, so as long as you start on cue it stays in step.

Useful when the music is coming from a speaker nobody controls.

---

## Layout

```
server/
  index.js     HTTP + WebSocket, one room per code
  rooms.js     the state machine: lobby → armed → countdown → live → reveal
  lyrics.js    LRCLIB lookup + free song search, LRC parsing, target timeline
  youtube.js   finds the video (YouTube Data API), quota, remembered matches
  youtube-ids.json  remembered song → video matches (commit it)
  songs.js     loads the jukebox
  jukebox/     ~3,000 songs, one "Artist | Title | Year" per line
  scoring.js   normalisation and the sing-off maths (pure, easy to test)
public/
  index.html   landing / join
  host.html    the big screen
  play.html    the phone
  youtube.js   the embedded YouTube player
  spotify.js   [SPOTIFY — kept for rollback] PKCE auth + Web Playback SDK
scripts/
  simulate.js        end-to-end test (Spotify path, YouTube with a fake API, ten teams)
  check-songs.js     lists jukebox songs LRCLIB has no synced lyrics for
  resolve-youtube.js pre-fills youtube-ids.json within the daily quota
```

Run the test with `npm test`. It plays a whole round headlessly in about
fifteen seconds and checks that the live target grows with playback, that the
same words are worth less once more of the song has gone by, and that the final
score is against the entire track.

---

## Honest limitations

- **Speech recognition quality varies by phone.** Chrome on Android is
  excellent. Safari on iOS 16+ works but drops out more often — SYNC restarts
  the recogniser automatically whenever it stops. Both players are on the same
  footing either way, so the game stays fair.
- **The mic hears the song too.** Some of what gets transcribed is Freddie
  Mercury, not you. It affects both players equally, and singing louder than the
  speakers is the counter — which is the point of the game.
- **Not every track has synced lyrics.** They come from
  [LRCLIB](https://lrclib.net), which is free, key-less and community-run.
  Studio singles are well covered; live cuts, remasters and deep album tracks
  often aren't. If SYNC says no lyrics, pick another version.
- **A round is as long as the song.** Three rounds of a four-minute track is
  most of an hour of continuous singing, and phones get warm. *End it here* is
  there for a reason.
- **Everything is in memory.** Restart the server and the rooms are gone. That's
  fine for a game night and keeps it deployable anywhere.

## Credits

Lyrics by [LRCLIB](https://lrclib.net). Playback by the
[YouTube IFrame Player API](https://developers.google.com/youtube/iframe_api_reference)
(Spotify Web Playback SDK kept for rollback).
Speech recognition by whatever is already in your phone.
