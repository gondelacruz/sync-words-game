# SYNC

A two-player sing-off. The laptop plays a famous song out loud, start to finish.
Both players hold their phones to their mouths and sing the whole thing. Whoever
gets more of the real lyrics out — judged by the phone's own speech recognition —
takes the point.

Nobody types anything. Nobody scores it by hand. The bars race in real time and
one of them wins.

```
  laptop (host screen)          phone            phone
  ├─ Spotify playback           ├─ mic           ├─ mic
  ├─ join code: 7KQ2            └─ speech→text   └─ speech→text
  └─ live scoreboard                  └────── words ──────┘
                                              ↓
                              server compares them to the lyrics
                                  that were actually playing
```

---

## How a round works

1. The host searches a song and hits **Sing the whole thing**.
2. SYNC pulls the **time-synced** lyrics for that track.
3. Countdown, then Spotify plays the track from the top. The round is the song:
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

You need **Node 20+** and a **Spotify Premium** account. Premium is Spotify's
requirement for playing full tracks in a browser, not ours.

### 1. Make a Spotify app

1. Go to <https://developer.spotify.com/dashboard> and create an app.
2. Add these **Redirect URIs**:
   - `http://127.0.0.1:3000/host.html`
   - `https://YOUR-APP.onrender.com/host.html` (once you've deployed)
3. Tick **Web Playback SDK** under "Which API/SDKs are you planning to use?"
4. Copy the **Client ID**.

> Since February 2026 a Development Mode app requires the owner to have Premium,
> allows **one** client ID per developer, and permits at most **five** authorised
> users. Only the host ever logs in, so five is plenty — but if a friend hosts,
> add their Spotify account under *Users and Access* in the dashboard.

### 2. Run it

```bash
npm install
SPOTIFY_CLIENT_ID=your_client_id npm start
# open http://127.0.0.1:3000
```

Use `127.0.0.1`, not `localhost` — Spotify only accepts the former as an
insecure redirect URI.

**The phones won't work against your laptop's local IP.** Browsers refuse
microphone access on plain `http://` outside localhost, so `http://192.168.x.x:3000`
will silently never get a mic. Deploy it (below), or tunnel it:

```bash
npx cloudflared tunnel --url http://127.0.0.1:3000
# then add the https URL it prints as a Spotify redirect URI, with /host.html
```

### 3. Deploy free on Render

`render.yaml` is already here.

1. Push this repo to GitHub.
2. On <https://render.com> → **New → Blueprint** → pick the repo.
3. Set the `SPOTIFY_CLIENT_ID` environment variable when prompted.
4. Add `https://<your-app>.onrender.com/host.html` to the Spotify redirect URIs.

The free tier sleeps after inactivity, so the first load of the night takes
about thirty seconds. After that it's instant.

---

## Playing

- **Laptop**: open the site, *Host on this screen*, connect Spotify, search a song.
  Pick how many points win the match; the round length is just the song.
- **Phones**: open the same URL, punch in the four-character code, tap
  **Arm my mic** once, and leave the page open.
- Speakers up, headphones off, phone close to your mouth. Sing loudly enough
  that your own voice beats the room.

Up to six phones can join. With two it's a head-to-head; with more it's a
free-for-all and the top score takes the point.

### Manual mode

Add `?manual=1` to the host URL (or click the link on the connect screen) and
SYNC skips Spotify entirely. You type the artist and title, it fetches the
lyrics, and *you* start the song from wherever you like — a phone, a record,
YouTube — from `0:00` when the counter says SING. Scoring follows the lyric
timestamps from there, so as long as you start on cue it stays in step.

Useful when the Spotify setup is being difficult, or when the music is coming
from a speaker nobody controls.

---

## Layout

```
server/
  index.js     HTTP + WebSocket, one room per code
  rooms.js     the state machine: lobby → armed → countdown → live → reveal
  lyrics.js    LRCLIB lookup, LRC parsing, and the per-line target timeline
  scoring.js   normalisation and the sing-off maths (pure, easy to test)
public/
  index.html   landing / join
  host.html    the big screen
  play.html    the phone
  spotify.js   PKCE auth + Web Playback SDK
scripts/
  simulate.js  end-to-end test: boots the server, fakes a host and two phones
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
[Spotify Web Playback SDK](https://developer.spotify.com/documentation/web-playback-sdk).
Speech recognition by whatever is already in your phone.
