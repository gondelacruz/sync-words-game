// ---------------------------------------------------------------------------
// Spotify PKCE auth + Web Playback SDK wrapper.
// PKCE means no client secret, so this is safe to run entirely in the browser.
// ---------------------------------------------------------------------------

const AUTH = 'https://accounts.spotify.com/authorize';
const TOKEN = 'https://accounts.spotify.com/api/token';
const SCOPES = [
  'streaming',
  'user-read-email',
  'user-read-private',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

const store = {
  get: (k) => { try { return JSON.parse(localStorage.getItem('sync:sp:' + k)); } catch { return null; } },
  set: (k, v) => localStorage.setItem('sync:sp:' + k, JSON.stringify(v)),
  del: (k) => localStorage.removeItem('sync:sp:' + k),
};

const redirectUri = () => location.origin + '/host.html';

function randomString(n) {
  const bytes = crypto.getRandomValues(new Uint8Array(n));
  return [...bytes].map((b) => ('0' + b.toString(16)).slice(-2)).join('');
}

async function challenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login(clientId) {
  const verifier = randomString(48);
  sessionStorage.setItem('sync:sp:verifier', verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    redirect_uri: redirectUri(),
    code_challenge_method: 'S256',
    code_challenge: await challenge(verifier),
    scope: SCOPES,
  });
  location.href = `${AUTH}?${params}`;
}

/** Handle the ?code= redirect, if we're sitting on one. Returns true if we did. */
export async function completeLogin(clientId) {
  const url = new URL(location.href);
  const code = url.searchParams.get('code');
  if (!code) {
    if (url.searchParams.get('error')) history.replaceState({}, '', location.pathname);
    return false;
  }
  const verifier = sessionStorage.getItem('sync:sp:verifier');
  history.replaceState({}, '', location.pathname);
  if (!verifier) return false;

  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  });
  if (!res.ok) return false;
  keep(await res.json());
  return true;
}

function keep(tok) {
  store.set('token', tok.access_token);
  store.set('expires', Date.now() + (tok.expires_in - 60) * 1000);
  if (tok.refresh_token) store.set('refresh', tok.refresh_token);
}

export async function token(clientId) {
  const t = store.get('token');
  if (t && Date.now() < (store.get('expires') || 0)) return t;

  const refresh = store.get('refresh');
  if (!refresh) return null;
  const res = await fetch(TOKEN, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: clientId, grant_type: 'refresh_token', refresh_token: refresh }),
  });
  if (!res.ok) { logout(); return null; }
  keep(await res.json());
  return store.get('token');
}

export function logout() { ['token', 'expires', 'refresh'].forEach(store.del); }
export const isLoggedIn = () => Boolean(store.get('token') || store.get('refresh'));

async function api(clientId, path, init = {}) {
  const t = await token(clientId);
  if (!t) throw new Error('no-token');
  const res = await fetch('https://api.spotify.com/v1' + path, {
    ...init,
    headers: { Authorization: 'Bearer ' + t, 'Content-Type': 'application/json', ...(init.headers || {}) },
  });
  if (res.status === 204) return null;
  if (!res.ok) throw Object.assign(new Error('spotify ' + res.status), { status: res.status });
  return res.json();
}

export async function search(clientId, q) {
  if (!q.trim()) return [];
  // Dev-mode apps are capped at limit=10 since Feb 2026.
  const data = await api(clientId, `/search?type=track&limit=10&q=${encodeURIComponent(q)}`);
  return (data?.tracks?.items || []).map((t) => ({
    id: t.id,
    uri: t.uri,
    name: t.name,
    artist: t.artists.map((a) => a.name).join(', '),
    album: t.album?.name || '',
    art: t.album?.images?.at(-2)?.url || t.album?.images?.[0]?.url || '',
    durationMs: t.duration_ms,
  }));
}

/* --- playback ------------------------------------------------------------ */
let player = null;
let deviceId = null;

export function playerReady() { return Boolean(deviceId); }

export function createPlayer(clientId, { onReady, onState, onError } = {}) {
  const boot = () => {
    player = new Spotify.Player({
      name: 'SYNG',
      volume: 0.85,
      getOAuthToken: (cb) => token(clientId).then((t) => t && cb(t)),
    });
    player.addListener('ready', ({ device_id }) => { deviceId = device_id; onReady?.(device_id); });
    player.addListener('not_ready', () => { deviceId = null; onReady?.(null); });
    player.addListener('player_state_changed', (s) => onState?.(s));
    for (const e of ['initialization_error', 'authentication_error', 'account_error', 'playback_error']) {
      player.addListener(e, ({ message }) => onError?.(e, message));
    }
    player.connect();
  };
  if (window.Spotify) boot();
  else window.onSpotifyWebPlaybackSDKReady = boot;
}

/** Must be called from inside a real click for iOS/Safari autoplay rules. */
export function unlockAudio() { try { player?.activateElement?.(); } catch {} }

export async function playTrack(clientId, uri, positionMs) {
  if (!deviceId) throw new Error('no-device');
  await api(clientId, `/me/player/play?device_id=${deviceId}`, {
    method: 'PUT',
    body: JSON.stringify({ uris: [uri], position_ms: Math.max(0, Math.round(positionMs)) }),
  });
}

export async function pause() { try { await player?.pause(); } catch {} }

export async function position() {
  const s = await player?.getCurrentState?.();
  return s ? s.position : null;
}
