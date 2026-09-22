// Shared bits: socket with auto-reconnect, tiny DOM helpers, confetti.

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
// Ten teams, ten colours that stay apart on a dark screen.
export const PLAYER_COLORS = [
  '#ff2e63', '#08f7fe', '#ffe600', '#b14eff', '#00ff87',
  '#ff8a00', '#4d7cff', '#ff7ad9', '#c6ff3d', '#f1efe7',
];
export const colorFor = (slot) => PLAYER_COLORS[slot % PLAYER_COLORS.length];

/** 1 -> "1st", 2 -> "2nd", 11 -> "11th" */
export function ordinal(n) {
  const v = n % 100;
  const suf = v >= 11 && v <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' }[n % 10] || 'th');
  return n + suf;
}

export function connect({ onOpen, onMessage, onDrop }) {
  const url = (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws';
  let ws, retry = 0, dead = false;

  const open = () => {
    ws = new WebSocket(url);
    ws.onopen = () => { retry = 0; onOpen?.(api); };
    ws.onmessage = (e) => { try { onMessage?.(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      if (dead) return;
      onDrop?.();
      retry = Math.min(retry + 1, 6);
      setTimeout(open, 400 * retry);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };
  open();

  const api = {
    send(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); },
    close() { dead = true; try { ws.close(); } catch {} },
    get ready() { return ws?.readyState === 1; },
  };
  return api;
}

export function shake(el = document.body, ms = 420) {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
  setTimeout(() => el.classList.remove('shake'), ms);
}

/* --- confetti ------------------------------------------------------------ */
let cv, ctx, bits = [], raf = 0;

function ensureCanvas() {
  if (cv) return;
  cv = document.createElement('canvas');
  cv.id = 'confetti';
  document.body.appendChild(cv);
  ctx = cv.getContext('2d');
  const size = () => {
    cv.width = innerWidth * devicePixelRatio;
    cv.height = innerHeight * devicePixelRatio;
    cv.style.width = innerWidth + 'px';
    cv.style.height = innerHeight + 'px';
  };
  size();
  addEventListener('resize', size);
}

function tick() {
  ctx.clearRect(0, 0, cv.width, cv.height);
  bits = bits.filter((b) => b.y < cv.height + 60);
  for (const b of bits) {
    b.vy += 0.42; b.x += b.vx; b.y += b.vy; b.rot += b.vr;
    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(b.rot);
    ctx.fillStyle = b.c;
    ctx.fillRect(-b.w / 2, -b.h / 2, b.w, b.h);
    ctx.restore();
  }
  raf = bits.length ? requestAnimationFrame(tick) : 0;
}

export function confetti(colors = PLAYER_COLORS, count = 190) {
  ensureCanvas();
  const dpr = devicePixelRatio;
  for (let i = 0; i < count; i++) {
    bits.push({
      x: cv.width * (0.5 + (Math.random() - 0.5) * 0.5),
      y: cv.height * 0.42 + Math.random() * 40,
      vx: (Math.random() - 0.5) * 22 * dpr,
      vy: (Math.random() * -20 - 6) * dpr,
      w: (6 + Math.random() * 8) * dpr,
      h: (10 + Math.random() * 14) * dpr,
      rot: Math.random() * 7,
      vr: (Math.random() - 0.5) * 0.4,
      c: colors[(Math.random() * colors.length) | 0],
    });
  }
  if (!raf) raf = requestAnimationFrame(tick);
}
