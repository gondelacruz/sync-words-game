// ---------------------------------------------------------------------------
// SYNG — the embedded YouTube player on the host screen (the default music
// source). One player for the whole game; it is moved on top of whichever
// ".ytSlot" box is on screen, so it can be a preview while the round is being
// set up and fill the left half of the screen while everybody sings.
//
// YouTube's rules for embeds: the player must stay visible (at least 200×200)
// while it plays, and nothing may be drawn over it. So the player hides itself
// whenever an overlay (announcement, countdown…) is open, and it only plays
// while it is visible.
// ---------------------------------------------------------------------------

const API = 'https://www.youtube.com/iframe_api';
const PLAYING = 1, ENDED = 0, PAUSED = 2;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let player = null;
let isReady = false;
let resolveReady;
const ready = new Promise((r) => { resolveReady = r; });
let handlers = {};
let live = false;            // a round is playing: pauses are undone, the end is reported
let cuedId = null;
let wrap = null;
let slot = null;

/** Load the IFrame API and build the player inside #ytPlayer. */
export function load({ onReady, onEnded, onError, onBlocked } = {}) {
  handlers = { onReady, onEnded, onError, onBlocked };
  wrap = document.getElementById('ytWrap');
  const create = () => {
    player = new window.YT.Player('ytPlayer', {
      width: '100%',
      height: '100%',
      playerVars: {
        playsinline: 1, rel: 0, iv_load_policy: 3, fs: 0, disablekb: 1, modestbranding: 1,
        origin: location.origin,
      },
      events: {
        onReady: () => { isReady = true; resolveReady(); handlers.onReady?.(); },
        onStateChange: (e) => onState(e.data),
        onError: (e) => handlers.onError?.(e.data),
      },
    });
  };
  if (window.YT?.Player) create();
  else {
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prev?.(); create(); };
    if (!document.querySelector(`script[src="${API}"]`)) {
      const s = document.createElement('script');
      s.src = API;
      s.async = true;
      s.onerror = () => handlers.onError?.('api-blocked');
      document.head.appendChild(s);
    }
  }
  addEventListener('resize', place);
  setInterval(place, 400);
}

export const playerReady = () => isReady;

function onState(st) {
  if (!live) return;
  if (st === ENDED) { live = false; handlers.onEnded?.(); }
  // Someone clicked pause (or the tab hiccuped): the round is timed to the
  // song, so keep it going.
  if (st === PAUSED) { try { player.playVideo(); } catch {} }
}

/** Show this video's first frame without playing it (the preview). */
export async function cue(id) {
  if (!id) return;
  await ready;
  if (cuedId === id || live) return;
  cuedId = id;
  try { player.cueVideoById({ videoId: id, startSeconds: 0 }); } catch {}
}

/**
 * Play from the top and resolve once audio is really running, with where the
 * needle is and how long the video is. If the browser blocks autoplay, the
 * host is asked to click the video once; we wait up to a minute for that.
 */
export async function play(id, fromMs = 0) {
  await ready;
  live = true;
  cuedId = id;
  wrap?.classList.add('live');
  player.loadVideoById({ videoId: id, startSeconds: Math.max(0, fromMs / 1000) });
  const t0 = Date.now();
  let nagged = false;
  while (live && Date.now() - t0 < 60000) {
    if (player.getPlayerState?.() === PLAYING) {
      wrap?.classList.remove('needclick');
      return { positionMs: Math.round(player.getCurrentTime() * 1000), durationMs: Math.round(player.getDuration() * 1000) };
    }
    if (!nagged && Date.now() - t0 > 3500) {
      nagged = true;
      wrap?.classList.add('needclick');           // clicks reach the player again
      handlers.onBlocked?.();
    }
    await sleep(60);
  }
  wrap?.classList.remove('needclick');
  throw new Error(live ? 'video did not start' : 'stopped');
}

/** Where the video is right now (ms), or null. */
export function position() {
  if (!player || player.getPlayerState?.() !== PLAYING) return null;
  return Math.round(player.getCurrentTime() * 1000);
}

/** Stop the music. Safe to call any time. */
export function stop() {
  const was = live;
  live = false;
  wrap?.classList.remove('live', 'needclick');
  if (!player || !isReady) return;
  try {
    const st = player.getPlayerState?.();
    if (was || st === PLAYING || st === 3) player.pauseVideo();
  } catch {}
}

export const isLive = () => live;

/**
 * Put the player over `el` (a .ytSlot), or hide it when `el` is null/hidden or
 * something is drawn on top of it.
 */
export function attach(el) { slot = el; place(); }

function overlayOpen() {
  return [...document.querySelectorAll('.overlay')].some((o) => !o.hidden);
}

function place() {
  if (!wrap) return;
  const r = slot && slot.offsetParent !== null ? slot.getBoundingClientRect() : null;
  const show = r && r.width >= 200 && r.height >= 112 && !overlayOpen();
  if (!show) {
    wrap.classList.add('parked');
    // Nothing may be drawn over a playing player, so a hidden player must not play.
    if (!live && player && isReady && player.getPlayerState?.() === PLAYING) { try { player.pauseVideo(); } catch {} }
    return;
  }
  wrap.classList.remove('parked');
  Object.assign(wrap.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
}
