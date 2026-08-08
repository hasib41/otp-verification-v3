/* =========================================================================
   GYRE — a four-digit code field that spins into one tile.
   Zero dependencies.

   The component is a state machine. One attribute — data-state on .sheet — is
   the only thing app.css reads, so the look can never disagree with the logic:

     idle ─▸ filling ─▸ checking ─▸ ok
                          └──────▸ error ─▸ filling

   The move, in one paragraph:

   When the fourth digit lands the row does not get replaced by a tick. Each
   box draws a breath — a small compression in place — and then the LINE CURLS:
   the four wrap clockwise onto a circle, the outer two pulling in to the sides
   while the inner two swing out to the top and the bottom, every one of them
   travelling in POLAR co-ordinates so it arcs rather than slides. Once they
   are on the track it spins: a turn and a quarter as one rigid body, wound up
   and then braked, each box turning with the rim so the digits tumble. A
   quarter turn is a symmetry of a four-point ring, so the four land back on
   the same four marks, and the digits unwind that quarter over the brake to
   finish upright — slower than the box they sit in, never against it. Nothing
   in the whole move ever reverses direction. That is the beat the code is
   accepted on — the edges, the digits and the track all drop their white
   light for the outcome's mint together, because four inputs have just become
   one object, and mint is one of only two hues the component ever shows.
   Then the radius is taken to nothing: the four screw down into the hub with
   one more part-turn while the tile turns in clockwise behind them. One
   continuous rotation, all of it the same way round, from the first curl to
   the last — nothing in the move ever reverses.

   Every step is transform and opacity. The row's layout box never moves: the
   clearance the orbit needs is reserved permanently in the neighbouring
   margins, so nothing below the boxes so much as twitches.
   ========================================================================= */

const N = 4;                 // digits
const REAL_CODE = '4719';    // the code "sent" to the phone
const COOLDOWN  = 30;        // resend lock, seconds

/* The orbit, as a multiple of one box. The four land a quarter turn apart, so
   their centres end up R·√2 from each other; at 1.12 that is 1.58 boxes,
   leaving well over half a box of air on every diagonal. Anything under about
   1.0 and they close up into a solid plus — they stop reading as four things
   on a ring and the track disappears behind them. Change this and --gyre-over
   in app.css has to change with it; that comment carries the arithmetic. */
const ORBIT_R = 1.12;

/* A turn and a quarter, one direction, never reversing.
   The quarter is free: 90° is a SYMMETRY of a four-point ring, so the four
   land on exactly the same four marks they left — just permuted — and a
   rounded square turned 90° is the same rounded square. The only thing a
   quarter turn disturbs is the digits, and those are righted separately as
   the ring brakes (see the unwind in the spin). */
const TURNS = 1.25;

const CURL_MS  = 660;
const CURL_LAG = 38;         // per box, so the line curls rather than snaps
const SPIN_MS  = 800;        // no stagger: on a rigid ring there is no lag
const HOLD_MS  = 360;        // the beat the ring is held, already mint
const SCREW_MS = 520;
const SCREW_LAG = 30;

/* Tells CSS the mirrored-digit layer is live. Until this lands, the native
   inputs render their own text — so a failed script degrades to a plain,
   usable four-box form rather than four blank boxes. */
document.documentElement.classList.add('gyre-live');

const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const isRecording = new URLSearchParams(location.search).has('record');

const sheet  = document.querySelector('.sheet');
const form   = document.getElementById('verify');
const wrap   = document.querySelector('.code-wrap');
const code   = document.querySelector('[data-code]');
const slots  = [...code.querySelectorAll('.slot')];
const inputs = slots.map((s) => s.querySelector('.slot__input'));
const digits = slots.map((s) => s.querySelector('.slot__digit'));
const wins   = slots.map((s) => s.querySelector('.slot__win'));
const halos  = slots.map((s) => s.querySelector('.slot__glow'));
const sparks = slots.map((s) => s.querySelector('.slot__spark'));
const arcs   = slots.map((s) => s.querySelector('.slot__arc'));

const track = document.querySelector('[data-track]');
const hub   = document.querySelector('[data-hub]');
const burst = document.querySelector('[data-burst]');

const errEl = document.querySelector('[data-err]');
const live  = document.querySelector('[data-live]');
const sms = document.querySelector('[data-sms]');
const fillBtn = document.querySelector('[data-fill]');
const resend = document.querySelector('[data-resend]');
const resendLabel = document.querySelector('[data-resend-label]');
const foot = document.querySelector('.verify__foot');
const done = document.querySelector('[data-done]');
const cont = document.querySelector('[data-continue]');

document.querySelector('[data-sms-code]').textContent = REAL_CODE;

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const round = (n) => Math.round(n * 100) / 100;
const TAU = Math.PI * 2;

/* Every JS-driven animation is parked here so a reset can cancel the lot and
   hand the resting state back to CSS. */
let running = [];
const play = (el, frames, opts) => {
  const a = el.animate(frames, opts);
  running.push(a);
  return a;
};

let state = 'idle';
let runId = 0;               // invalidates a sequence that is still in flight
let clearTimer = 0;
let coolTimer = 0;
let redirecting = false;

function setState(next) {
  state = next;
  sheet.dataset.state = next;
}

function say(msg) {
  live.textContent = '';           // force a re-announce of identical text
  requestAnimationFrame(() => { live.textContent = msg; });
}

/* ---------- easing --------------------------------------------------------
   Baked into the SAMPLING rather than handed to WAAPI. An options-level
   easing is applied to every keyframe interval separately, so a curve on a
   twenty-sample arc would ease twenty times and read as stepping. Sampled
   with the curve already in the numbers, the animation itself is linear and
   the motion is the shape of the function.
   -------------------------------------------------------------------------- */

const outCubic = (t) => 1 - (1 - t) ** 3;
/* A small overshoot on arrival, so the four settle onto the ring instead of
   stopping dead on it. */
const outBack = (t, s = 1.5) => 1 + (s + 1) * (t - 1) ** 3 + s * (t - 1) ** 2;

/* ---------- sound ---------------------------------------------------------
   Built lazily and only after a real gesture, so nothing is ever created —
   let alone played — on load.
   -------------------------------------------------------------------------- */

let armed = false;
let ac = null;
let noiseBuf = null;

addEventListener('pointerdown', () => { armed = true; }, { once: true, passive: true });
addEventListener('keydown', () => { armed = true; }, { once: true });

function ctx() {
  if (!armed) return null;
  if (ac === null) {
    try { ac = new (window.AudioContext || window.webkitAudioContext)(); }
    catch { ac = false; }
  }
  if (ac && ac.state === 'suspended') ac.resume();
  return ac || null;
}

function noise(c) {
  if (!noiseBuf) {
    const len = Math.floor(c.sampleRate * 0.6);
    noiseBuf = c.createBuffer(1, len, c.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i += 1) d[i] = Math.random() * 2 - 1;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf;
  src.loop = true;
  return src;
}

/* A keystroke is FOLEY, never a note: a dry click with its energy in the
   3–6 kHz band and a little low body under it, identical on every press. A
   pitched blip — worse, a different pitch per box — turns typing into a tune,
   which is the single fastest way to make a UI sound like a toy. */
function click() {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;

  const hi = noise(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = 4200;
  bp.Q.value = 0.9;
  const gh = c.createGain();
  gh.gain.setValueAtTime(0.0001, t);
  gh.gain.exponentialRampToValueAtTime(0.13, t + 0.001);
  gh.gain.exponentialRampToValueAtTime(0.0001, t + 0.03);
  hi.connect(bp).connect(gh).connect(c.destination);
  hi.start(t); hi.stop(t + 0.05);

  const lo = noise(c);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 480;
  const gl = c.createGain();
  gl.gain.setValueAtTime(0.0001, t);
  gl.gain.exponentialRampToValueAtTime(0.05, t + 0.002);
  gl.gain.exponentialRampToValueAtTime(0.0001, t + 0.024);
  lo.connect(lp).connect(gl).connect(c.destination);
  lo.start(t); lo.stop(t + 0.05);
}

/* Air moving, for the spin: a band of noise swept up as the ring winds on and
   back down as it brakes. Untuned, so it never lands on a note beside the
   success chime. */
function whoosh(ms) {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;
  const d = ms / 1000;

  const src = noise(c);
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 1.3;
  bp.frequency.setValueAtTime(320, t);
  bp.frequency.exponentialRampToValueAtTime(1700, t + d * 0.52);
  bp.frequency.exponentialRampToValueAtTime(420, t + d);

  const g = c.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(0.075, t + d * 0.4);
  g.gain.linearRampToValueAtTime(0.05, t + d * 0.72);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);

  src.connect(bp).connect(g).connect(c.destination);
  src.start(t); src.stop(t + d + 0.05);
}

/* The four arriving at the hub: a low body with a short filtered knock. */
function thunk() {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime;

  const o = c.createOscillator();
  const g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(150, t);
  o.frequency.exponentialRampToValueAtTime(64, t + 0.16);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.1, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.24);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + 0.28);

  const n = noise(c);
  const lp = c.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 1400;
  const gn = c.createGain();
  gn.gain.setValueAtTime(0.0001, t);
  gn.gain.exponentialRampToValueAtTime(0.06, t + 0.004);
  gn.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  n.connect(lp).connect(gn).connect(c.destination);
  n.start(t); n.stop(t + 0.12);
}

function tone(freq, dur, vol, type = 'sine', at = 0) {
  const c = ctx();
  if (!c) return;
  const t = c.currentTime + at;
  const o = c.createOscillator();
  const g = c.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(c.destination);
  o.start(t); o.stop(t + dur + 0.02);
}

/* The outcome IS allowed to be musical — it is a verdict, not a keystroke. */
const sndOk  = () => { tone(659, 0.11, 0.075); tone(988, 0.2, 0.07, 'sine', 0.1); };
const sndErr = () => { tone(196, 0.16, 0.085, 'sawtooth'); tone(147, 0.22, 0.065, 'sawtooth', 0.09); };
const sndLock = () => { tone(523, 0.09, 0.05, 'triangle'); };

/* ---------- the value ----------------------------------------------------- */

const valueOf = () => inputs.map((i) => i.value).join('');
const isComplete = () => valueOf().length === N;
const firstEmpty = () => {
  const i = inputs.findIndex((el) => !el.value);
  return i === -1 ? N - 1 : i;
};

/**
 * Write one digit.
 *
 * popDelay >= 0 plays it: the glyph is stamped into the box, the box takes a
 * flash of light, and a charge runs its border. -1 writes it silently (used by
 * reset).
 */
function setDigit(i, ch, popDelay = -1) {
  /* What leaves is what was on SCREEN, not what was in the input. A rejected
     keystroke ("a") lands in the input for an instant before it is stripped;
     reading the input here would animate a letter out of a box the user never
     saw it in. */
  const prev = digits[i].textContent;
  inputs[i].value = ch;
  slots[i].classList.toggle('is-filled', !!ch);

  if (prev === ch) return;

  digits[i].textContent = ch;

  if (popDelay < 0 || reduced) return;

  /* the outgoing glyph leaves on its own throwaway node */
  if (prev) {
    const ghost = digits[i].cloneNode(false);
    ghost.textContent = prev;
    wins[i].appendChild(ghost);
    const out = play(ghost, [
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(0.7)', opacity: 0 },
    ], { duration: 200, delay: popDelay, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'backwards' });
    out.finished.then(() => ghost.remove(), () => ghost.remove());
  }

  if (!ch) return;

  /* The travel stays inside the box on purpose: a composited transform can
     slip an ancestor's overflow clip, and a digit hanging above its box is the
     one failure that reads as broken. */
  play(digits[i], [
    { transform: 'scale(1.45)', opacity: 0, offset: 0 },
    { transform: 'scale(0.95)', opacity: 1, offset: 0.55 },
    { transform: 'scale(1)', opacity: 1, offset: 1 },
  ], { duration: 330, delay: popDelay, easing: 'cubic-bezier(0.2, 1.25, 0.3, 1)', fill: 'backwards' });

  play(halos[i], [
    { transform: 'scale(0.88)', opacity: 0 },
    { transform: 'scale(1.04)', opacity: 0.85, offset: 0.42 },
    { transform: 'scale(1.2)', opacity: 0 },
  ], { duration: 640, delay: popDelay + 30, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' });

  setTimeout(click, popDelay);
}

/* One lap of a box's border. Used per keystroke and again, all four at once,
   as the ring winds up. */
function charge(i, delay = 0, duration = 700) {
  if (reduced) return;
  play(arcs[i], [{ strokeDashoffset: 1 }, { strokeDashoffset: 0 }],
    { duration, delay, easing: 'cubic-bezier(0.35, 0, 0.15, 1)' });
  play(sparks[i], [
    { opacity: 0, offset: 0 },
    { opacity: 1, offset: 0.1 },
    { opacity: 1, offset: 0.78 },
    { opacity: 0, offset: 1 },
  ], { duration: duration + 60, delay, easing: 'linear' });
}

/* ---------- the gyre ------------------------------------------------------ */

/**
 * Measure the row and work out the circle it curls onto.
 *
 * Everything is derived from the boxes' own measured rects, so the orbit is
 * correct at any viewport without duplicating the row's layout maths — and
 * because it is measured at spin time, a resize mid-typing cannot stale it.
 */
function measureOrbit() {
  const r = slots.map((s) => s.getBoundingClientRect());
  const box = wrap.getBoundingClientRect();
  const w = r[0].width;
  const h = r[0].height;

  const cx = (r[0].left + r[N - 1].right) / 2;   // the hub
  const cy = r[0].top + h / 2;
  const R = w * ORBIT_R;

  /* Each box's own centre, and where it starts in polar terms. Every box sits
     on the row's centre line, so the start angle is exactly left or exactly
     right and the start radius is just the horizontal offset. */
  const p = r.map((b) => [b.left + b.width / 2, b.top + b.height / 2]);
  const a0 = p.map(([x]) => (x < cx ? Math.PI : 0));
  const r0 = p.map(([x]) => Math.abs(x - cx));

  /* Where each box ends up: the row wraps CLOCKWISE onto the ring starting at
     the left, so 0→left, 1→top, 2→right, 3→bottom. Read in order that is one
     continuous curl rather than four independent moves. */
  const a1 = slots.map((_, i) => Math.PI + (i * Math.PI) / 2);

  /* The turn each box makes on the way there, normalised so it never takes
     the long way round: 0 and 2 are already on their marks angularly and only
     change radius; 1 and 3 swing a quarter turn. */
  const turn = a1.map((a, i) => {
    let d = (a - a0[i]) % TAU;
    if (d < 0) d += TAU;
    if (d > Math.PI) d -= TAU;
    return d;
  });

  return { w, h, R, cx, cy, box, p, a0, r0, a1, turn };
}

/* One box's transform at one point on the path. The rotation is the box's own
   turn about its centre; on the ring it is kept equal to the angle travelled,
   which is what makes the four behave as one rigid body rather than four
   things that happen to be moving together. */
function at(g, i, ang, rad, rot, sc) {
  const x = g.cx + Math.cos(ang) * rad - g.p[i][0];
  const y = g.cy + Math.sin(ang) * rad - g.p[i][1];
  return `translate(${round(x)}px, ${round(y)}px) rotate(${round(rot)}deg) scale(${round(sc)})`;
}

/* How far box i has to be moved to sit on its mark on the ring. The curl ends
   here and the spin begins here, so both read it from the same function. */
function ringDelta(g, i) {
  return [
    round(g.cx + Math.cos(g.a1[i]) * g.R - g.p[i][0]),
    round(g.cy + Math.sin(g.a1[i]) * g.R - g.p[i][1]),
  ];
}

/* The track's size and place are LAYOUT — written once, before anything
   animates. After this only scale, rotate and opacity are ever touched. */
function layoutOrbit(g) {
  const L = g.box.left;
  const O = g.box.top;
  const d = g.R * 2;

  track.style.width = `${round(d)}px`;
  track.style.height = `${round(d)}px`;
  track.style.left = `${round(g.cx - g.R - L)}px`;
  track.style.top = `${round(g.cy - g.R - O)}px`;

  hub.style.left = `${round(g.cx - L)}px`;
  hub.style.top = `${round(g.cy - O)}px`;
}

function clearOrbit() {
  track.style.opacity = '';
  track.style.transform = '';
  hub.style.opacity = '';
  hub.style.transform = '';
}

/* ---------- confetti ------------------------------------------------------ */

const MOTES = 18;

/* Light coming off the tile. Few, round, and slower than they are fast — the
   restraint is the point: a wide fast scatter of squares reads as a party
   popper, which is the one thing a verification screen should not read as. */
function throwMotes() {
  if (reduced) return;
  for (let i = 0; i < MOTES; i += 1) {
    const mote = document.createElement('span');
    mote.className = 'mote';
    if (i % 3 === 0) mote.classList.add('mote--sm');
    if (i % 5 === 0) mote.classList.add('mote--lg');
    if (i % 4 === 1) mote.classList.add('mote--pale');
    burst.appendChild(mote);

    /* Evenly spaced with a little jitter, so it looks scattered without ever
       leaving a quadrant empty the way pure random does. */
    const a = (i / MOTES) * TAU + (Math.random() - 0.5) * 0.55;
    const dist = 74 + Math.random() * 76;

    const anim = mote.animate([
      { transform: 'translate(0, 0) scale(0.2)', opacity: 0, offset: 0 },
      { transform: `translate(${Math.cos(a) * dist * 0.36}px, ${Math.sin(a) * dist * 0.36}px) scale(1)`, opacity: 1, offset: 0.2 },
      { transform: `translate(${Math.cos(a) * dist * 0.72}px, ${Math.sin(a) * dist * 0.72 + 8}px) scale(0.9)`, opacity: 0.95, offset: 0.58 },
      { transform: `translate(${Math.cos(a) * dist}px, ${Math.sin(a) * dist + 18}px) scale(0.4)`, opacity: 0, offset: 1 },
    ], {
      duration: 1100 + Math.random() * 420,
      delay: 60 + Math.random() * 130,
      easing: 'cubic-bezier(0.12, 0.75, 0.28, 1)',
    });
    running.push(anim);
    anim.finished.then(() => mote.remove(), () => mote.remove());
  }
}

/* ---------- typing -------------------------------------------------------- */

function focusSlot(i) {
  const el = inputs[Math.max(0, Math.min(N - 1, i))];
  el.focus({ preventScroll: true });
  el.select();
}

function onInput(e, i) {
  if (state === 'error') abortErrorHold();

  const typed = e.target.value.replace(/\D/g, '');

  if (!typed) {                       // the field was emptied
    setDigit(i, '', 0);
    setState('filling');
    return;
  }

  if (typed.length > 1) {             // paste, or an OS autofill of all four
    distribute(typed, i);
    return;
  }

  setDigit(i, typed, 0);
  charge(i);
  setState('filling');

  if (i < N - 1 && !isComplete()) focusSlot(i + 1);
  else if (i < N - 1) focusSlot(firstEmpty());

  maybeSubmit();
}

function distribute(str, from) {
  const chars = str.slice(0, N);
  const start = chars.length >= N ? 0 : from;
  let i = start;

  for (const ch of chars) {
    if (i >= N) break;
    setDigit(i, ch, (i - start) * 60);
    charge(i, (i - start) * 60);
    i += 1;
  }

  setState('filling');
  focusSlot(Math.min(i, N - 1));
  maybeSubmit();
}

function onKeyDown(e, i) {
  if (e.metaKey || e.ctrlKey) return;              // leave ⌘V / ⌃V alone
  if (state === 'error') abortErrorHold();

  switch (e.key) {
    case 'Backspace':
      e.preventDefault();
      if (inputs[i].value) {
        setDigit(i, '', 0);
      } else if (i > 0) {
        setDigit(i - 1, '', 0);
        focusSlot(i - 1);
      }
      setState('filling');
      break;

    case 'Delete':
      e.preventDefault();
      setDigit(i, '', 0);
      break;

    case 'ArrowLeft':  e.preventDefault(); focusSlot(i - 1); break;
    case 'ArrowRight': e.preventDefault(); focusSlot(i + 1); break;
    case 'Home':       e.preventDefault(); focusSlot(0); break;
    case 'End':        e.preventDefault(); focusSlot(firstEmpty()); break;
    default: break;
  }
}

function onPaste(e, i) {
  const text = (e.clipboardData || window.clipboardData)?.getData('text') ?? '';
  const only = text.replace(/\D/g, '');
  if (!only) return;
  e.preventDefault();
  if (state === 'error') abortErrorHold();
  distribute(only, i);
}

/* Clicking into the middle of a half-typed code lands you where the next digit
   actually goes — the standard OTP behaviour. */
function onFocus(i) {
  inputs[i].select();
  const target = firstEmpty();
  if (redirecting || isComplete() || i <= target) return;
  redirecting = true;
  focusSlot(target);
  requestAnimationFrame(() => { redirecting = false; });
}

inputs.forEach((el, i) => {
  el.addEventListener('input', (e) => onInput(e, i));
  el.addEventListener('keydown', (e) => onKeyDown(e, i));
  el.addEventListener('paste', (e) => onPaste(e, i));
  el.addEventListener('focus', () => onFocus(i));
});

/* ---------- verify -------------------------------------------------------- */

/* Auto-verify on completion — but not on the same tick as the last keystroke.
   The digit is still landing; curling the row out from under it reads as a
   dropped frame. One short settle serves every route in. */
let submitTimer = 0;

function maybeSubmit() {
  clearTimeout(submitTimer);
  if (!isComplete() || state === 'checking' || state === 'ok') return;
  submitTimer = setTimeout(() => {
    if (isComplete() && state !== 'checking' && state !== 'ok') form.requestSubmit();
  }, reduced ? 0 : 340);
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  if (state === 'checking' || state === 'ok') return;
  if (!isComplete()) {
    focusSlot(firstEmpty());
    return;
  }
  check(valueOf());
});

async function check(entered) {
  setState('checking');
  errEl.textContent = '';
  hideSms();
  inputs.forEach((el) => { el.disabled = true; el.removeAttribute('aria-invalid'); });
  say('Checking your code.');

  const token = ++runId;

  if (entered !== REAL_CODE) {
    await wait(reduced ? 200 : 620);
    if (token !== runId) return;
    fail();
    return;
  }

  if (reduced) {
    succeed();
    return;
  }

  await gyre(token);
  if (token !== runId) return;
  succeed();
}

/**
 * The gyre. Three beats, and the layout never reflows through any of them.
 *
 *   1  a breath, then the line curls clockwise onto the ring
 *   2  two whole turns as one rigid body — wound up, then braked onto the mark
 *   3  the radius goes to nothing and the four screw down into the hub
 */
async function gyre(token) {
  const g = measureOrbit();
  layoutOrbit(g);

  /* ---- 1. the curl ------------------------------------------------------
     Sampled in POLAR co-ordinates: angle and radius are interpolated
     separately and only turned into x/y at the end, which is what bends the
     path into an arc. Interpolating x/y directly would draw a straight line
     between the same two points, and a straight line to a circle is the one
     thing that would give the whole move away. */
  /* Sampled, but at a quarter turn spread over 20 steps the widest angular
     step is a few degrees and the chord sag stays well under a pixel. */
  const CURL_STEPS = 20;
  slots.forEach((s, i) => {
    const frames = [
      { transform: at(g, i, g.a0[i], g.r0[i], 0, 1), offset: 0 },
      { transform: at(g, i, g.a0[i], g.r0[i], 0, 0.9), offset: 0.16 },   // the breath
    ];
    for (let k = 1; k <= CURL_STEPS; k += 1) {
      const t = k / CURL_STEPS;
      const e = outBack(t);
      const ang = g.a0[i] + g.turn[i] * outCubic(t);
      const rad = g.r0[i] + (g.R - g.r0[i]) * e;
      /* No self-rotation at all on the way in — the boxes travel their arcs
         flat and land upright.
         This used to BANK: lean into the corner, level out on arrival. It
         looked good and it was wrong. A lean that returns to zero is a
         clockwise tilt followed by an anticlockwise one, so the two boxes that
         actually swing (1 and 3) reversed for ~17 frames right before the
         spin — measurably, -4.6° at the end of the curl. One reversal in an
         otherwise single-direction move is the thing the eye catches. The two
         boxes that only change radius never banked, so it did not even apply
         to all four. Rotation now starts at the spin and only ever climbs. */
      frames.push({
        transform: at(g, i, ang, rad, 0, 0.9 + 0.1 * outCubic(t)),
        offset: 0.16 + 0.84 * t,
      });
    }
    play(s, frames, { duration: CURL_MS, delay: i * CURL_LAG, easing: 'linear', fill: 'forwards' });
    setTimeout(click, i * CURL_LAG);
  });

  /* the track draws itself in under them */
  track.style.opacity = '1';
  play(track, [
    { transform: 'scale(0.72) rotate(-24deg)', opacity: 0 },
    { transform: 'scale(1) rotate(0deg)', opacity: 1 },
  ], { duration: CURL_MS, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'both' });

  await wait(CURL_MS + CURL_LAG * (N - 1) + 60);
  if (token !== runId) return;

  /* ---- 2. the spin ------------------------------------------------------
     NOT sampled. A revolution about a point is a native transform, so this
     hands the whole orbit to the browser: move each box's TRANSFORM-ORIGIN to
     the hub and a plain rotate() sweeps it round an exact circle while turning
     it by the same angle — one rigid ring, from two keyframes.

     Sampling this was a real bug, not a stylistic choice. Keyframes interpolate
     the translate LINEARLY, so a sampled orbit cuts a straight chord across
     each arc instead of following it; with the angle eased, mid-spin steps ran
     near 100° and the chord sag pulled the radius in by 16px, ~20 times a
     second. It read as a shake. The curl above can be sampled because its
     angular steps stay small and its radius is changing anyway; a full turn
     cannot.

     The ring turns a quarter past a full revolution and every box therefore
     lands on a mark — the next one round — so the formation at rest is
     identical to the formation it left. */
  const total = TURNS * 360;
  const REST = total % 360;          // 90°: what the digits have to give back

  slots.forEach((s, i) => {
    /* The hub, in this box's own untransformed co-ordinates. Legal well
       outside the element's own box. */
    s.style.transformOrigin =
      `${round(g.cx - g.p[i][0] + g.w / 2)}px ${round(g.cy - g.p[i][1] + g.h / 2)}px`;

    /* At 0° this is a pure translation, and a pure translation is
       origin-independent — so the origin can be swapped in on the frame the
       curl lands without moving anything by a pixel. */
    const d = ringDelta(g, i);
    play(s, [
      { transform: `rotate(0deg) translate(${d[0]}px, ${d[1]}px)` },
      { transform: `rotate(${total}deg) translate(${d[0]}px, ${d[1]}px)` },
    ], { duration: SPIN_MS, easing: 'cubic-bezier(0.62, 0, 0.38, 1)', fill: 'forwards' });

    /* The digits give the quarter back. They ride the box untouched for the
       fast part of the turn — that is the tumble — and then unwind REST over
       the brake, so they finish upright. The unwind is SLOWER than the box it
       sits in, never opposite to it: the glyph's own angle still climbs the
       whole way, it just stops climbing at zero. Nothing in the move ever
       reverses direction.
       It rides .slot__win rather than .slot so it cannot collide with the
       orbit's transform, and the box beneath is a rounded square, which needs
       no righting of its own. */
    play(wins[i], [
      { transform: 'rotate(0deg)', offset: 0 },
      { transform: 'rotate(0deg)', offset: 0.62 },
      { transform: `rotate(${-REST}deg)`, offset: 1 },
    ], { duration: SPIN_MS, easing: 'cubic-bezier(0.32, 0, 0.2, 1)', fill: 'forwards' });
  });

  /* The track turns WITH the ring, never against it — but at a fraction of
     the speed. The separation still comes from the difference between the two
     rates, which is parallax; opposing them would just be a second, contrary
     motion for the eye to unpick. */
  play(track, [
    { transform: 'scale(1) rotate(0deg)', opacity: 1, offset: 0 },
    { transform: 'scale(1.05) rotate(34deg)', opacity: 0.85, offset: 0.5 },
    { transform: 'scale(1) rotate(52deg)', opacity: 1, offset: 1 },
  ], { duration: SPIN_MS, easing: 'ease-in-out', fill: 'forwards' });

  /* the hub is lit before anything is asked to fall into it */
  hub.style.opacity = '1';
  play(hub, [
    { transform: 'scale(0.3)', opacity: 0 },
    { transform: 'scale(1)', opacity: 0.9 },
  ], { duration: 420, easing: 'cubic-bezier(0.22, 1, 0.36, 1)', fill: 'forwards' });

  slots.forEach((_, i) => charge(i, i * 40, SPIN_MS * 0.72));
  whoosh(SPIN_MS);

  await wait(SPIN_MS);
  if (token !== runId) return;

  /* The ring closed and every box is back on its mark: four inputs are one
     object now. One attribute, so app.css owns every pixel of the hand-over. */
  sheet.dataset.locked = '';
  sndLock();

  slots.forEach((s) => play(s.querySelector('.slot__glow'), [
    { transform: 'scale(0.9)', opacity: 0 },
    { transform: 'scale(1.18)', opacity: 0.9, offset: 0.4 },
    { transform: 'scale(1.4)', opacity: 0 },
  ], { duration: 520, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)' }));

  await wait(HOLD_MS);
  if (token !== runId) return;

  /* ---- 3. the screw down ------------------------------------------------
     Also exact, and for a pleasing reason. Still turning about the hub, the
     box is scaled to END_S and its translate is retargeted to -END_S·v0. Work
     the composite through and the box's own offset cancels out completely:
     the centre travels straight from the ring to the hub while the rotation
     keeps running, which IS a spiral — no sampling, two keyframes.
     The tile is already turning in at the same point, the same way round.
     See .seal__tile in app.css. */
  const END_S = 0.24;
  const EXTRA = 150;                 // the last part-turn, degrees

  slots.forEach((s, i) => {
    const d = ringDelta(g, i);
    const v0x = g.p[i][0] - g.cx;
    const v0y = g.p[i][1] - g.cy;

    play(s, [
      { transform: `rotate(${total}deg) translate(${d[0]}px, ${d[1]}px) scale(1)` },
      { transform: `rotate(${total + EXTRA}deg) translate(${round(-END_S * v0x)}px, ${round(-END_S * v0y)}px) scale(${END_S})` },
    ], { duration: SCREW_MS, delay: i * SCREW_LAG, easing: 'cubic-bezier(0.55, 0, 0.35, 1)', fill: 'forwards' });

    /* Opacity rides its own animation rather than the transform keyframes, so
       it can hold and then go without forcing the path to be sampled. */
    play(s, [
      { opacity: 1, offset: 0 },
      { opacity: 1, offset: 0.62 },
      { opacity: 0, offset: 1 },
    ], { duration: SCREW_MS, delay: i * SCREW_LAG, easing: 'linear', fill: 'forwards' });
  });

  slots.forEach((s) => play(s.querySelector('.slot__win'), [
    { opacity: 1 }, { opacity: 0 },
  ], { duration: 260, delay: SCREW_MS * 0.4, easing: 'linear', fill: 'forwards' }));

  play(track, [
    { transform: 'scale(1) rotate(52deg)', opacity: 1 },
    { transform: 'scale(0.1) rotate(96deg)', opacity: 0 },
  ], { duration: SCREW_MS, easing: 'cubic-bezier(0.6, 0, 0.3, 1)', fill: 'forwards' });

  /* the hub takes the impact and hands the centre to the tile */
  play(hub, [
    { transform: 'scale(1)', opacity: 0.9, offset: 0 },
    { transform: 'scale(1.8)', opacity: 1, offset: 0.78 },
    { transform: 'scale(3.2)', opacity: 0, offset: 1 },
  ], { duration: SCREW_MS + 120, easing: 'cubic-bezier(0.5, 0, 0.3, 1)', fill: 'forwards' });

  setTimeout(thunk, SCREW_MS * 0.72);

  await wait(SCREW_MS + SCREW_LAG * (N - 1) + 40);
}

function succeed() {
  setState('ok');
  say('Code verified. Your number has been verified.');
  stopCooldown();
  sndOk();
  throwMotes();

  /* Focus follows the outcome: the only thing left to do is Continue. */
  done.removeAttribute('inert');
  setTimeout(() => { if (state === 'ok') cont.focus({ preventScroll: true }); }, 520);
}

function fail() {
  setState('error');
  errEl.textContent = "That code isn't right — check your messages.";
  inputs.forEach((el) => {
    el.disabled = false;
    el.setAttribute('aria-invalid', 'true');
  });
  say("That code isn't right — check your messages.");
  sndErr();

  /* Checking disabled the boxes, which dropped focus. Put it straight back so
     a correction can be typed without reaching for the mouse. */
  focusSlot(0);

  /* Hold the wrong digits long enough to read, then rub them out from the
     right — the same direction they were typed, reversed. */
  const token = runId;
  clearTimer = setTimeout(async () => {
    for (let i = N - 1; i >= 0; i -= 1) {
      if (token !== runId) return;
      setDigit(i, '', 0);
      if (!reduced) await wait(56);
    }
    if (state !== 'error' || token !== runId) return;
    clearError();
    focusSlot(0);
  }, reduced ? 400 : 950);
}

function clearError() {
  clearTimeout(clearTimer);
  clearTimer = 0;
  inputs.forEach((el) => el.removeAttribute('aria-invalid'));
  setState('filling');
}

/* Typing during the hold takes over from it: the stale digits go at once so
   the correction starts from an empty row, not from a half-wrong one. */
function abortErrorHold() {
  clearError();
  for (let i = 0; i < N; i += 1) setDigit(i, '', 0);
}

/* ---------- the message --------------------------------------------------- */

/* A message that lands after the code is already in flight is just noise — and
   it would be sitting over the foot of the sheet at the exact moment the ring
   wants that room. */
function showSms() {
  if (state === 'checking' || state === 'ok') return;
  sms.classList.add('is-in');
  /* The chip covers the resend line, so that line must also stop being
     reachable — an invisible control you can still tab to is worse than a
     visible one you cannot use. */
  sheet.dataset.msg = '';
  foot.setAttribute('inert', '');
}

function hideSms() {
  sms.classList.remove('is-in');
  delete sheet.dataset.msg;
  foot.removeAttribute('inert');
}

fillBtn.addEventListener('click', () => type(REAL_CODE));

/* On a real Android device the browser offers the code itself and the mock
   message above never appears. Aborted on submit, per the spec. */
function readOtpFromSms() {
  if (!('OTPCredential' in window) || !window.isSecureContext) return;
  const abort = new AbortController();
  form.addEventListener('submit', () => abort.abort(), { once: true });

  navigator.credentials
    .get({ otp: { transport: ['sms'] }, signal: abort.signal })
    .then((otp) => { if (otp?.code) { hideSms(); type(otp.code.replace(/\D/g, '')); } })
    .catch(() => {});
}

/* ---------- resend -------------------------------------------------------- */

function startCooldown() {
  let left = COOLDOWN;
  resend.disabled = true;
  resendLabel.textContent = `Resend in ${left}s`;

  clearInterval(coolTimer);
  coolTimer = setInterval(() => {
    left -= 1;
    if (left <= 0) {
      stopCooldown();
      return;
    }
    resendLabel.textContent = `Resend in ${left}s`;
  }, 1000);
}

function stopCooldown() {
  clearInterval(coolTimer);
  coolTimer = 0;
  resend.disabled = false;
  resendLabel.textContent = 'Resend';
}

resend.addEventListener('click', () => {
  if (resend.disabled) return;
  startCooldown();
  say('A new code is on its way.');
  for (let i = 0; i < N; i += 1) setDigit(i, '');
  setState('filling');
  focusSlot(0);
  setTimeout(showSms, 900);
});

/* ---------- reset (used by Continue, by Escape and by the recorder) -------- */

cont.addEventListener('click', reset);

function reset() {
  runId += 1;                       // orphan anything still in flight
  clearTimeout(clearTimer);
  clearTimeout(submitTimer);
  running.forEach((a) => a.cancel());
  running = [];
  burst.replaceChildren();
  clearOrbit();
  slots.forEach((s) => {
    s.style.transform = '';
    s.style.opacity = '';
    s.style.transformOrigin = '';   // the spin parks it on the hub
  });
  done.setAttribute('inert', '');
  delete sheet.dataset.locked;
  inputs.forEach((el) => {
    el.disabled = false;
    el.removeAttribute('aria-invalid');
  });
  for (let i = 0; i < N; i += 1) setDigit(i, '');
  errEl.textContent = '';
  hideSms();
  setState('idle');
  stopCooldown();
  startCooldown();
  focusSlot(0);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state !== 'idle') reset();
});

/* An orbit measured against one viewport is wrong on another — but only a
   WIDTH change can invalidate it, because the width is the only thing that
   moves the row it was measured from.

   Guarding on width rather than on "a resize happened" is what makes this
   work on a phone at all. Both the soft keyboard and the disappearing URL bar
   fire resize with the height alone changing — and check() disables the
   inputs, which blurs the field and closes the keyboard, so on mobile a
   height-only resize arrives almost exactly when the gyre starts. Resetting
   on that threw the whole animation away on the frame it began. */
let vw = innerWidth;
addEventListener('resize', () => {
  if (innerWidth === vw) return;         // height only — keyboard or URL bar
  vw = innerWidth;
  if (state === 'checking') reset();
});

/* ---------- boot ---------------------------------------------------------- */

startCooldown();
focusSlot(0);
readOtpFromSms();

/* The message lands a beat after the screen does — unless the code is already
   in, in which case it would be arriving to announce something you did. The
   rig suppresses the timer and calls showSms() on the beat it wants. */
if (!isRecording) setTimeout(() => { if (!valueOf()) showSms(); }, 1600);

/* The recorder drives the same public surface a user does — no private path,
   so what gets filmed is what ships. It only runs once start() is called,
   after the rig's pre-roll. */
async function type(str) {
  if (state === 'checking' || state === 'ok') return;
  if (state === 'error') abortErrorHold();
  hideSms();
  inputs.forEach((el) => { el.disabled = false; });
  for (let i = 0; i < N; i += 1) setDigit(i, '');
  setState('filling');
  focusSlot(0);

  const chars = str.slice(0, N).split('');
  for (let i = 0; i < chars.length; i += 1) {
    setDigit(i, chars[i], 0);
    charge(i);
    if (i < N - 1) focusSlot(i + 1);
    if (!reduced) await wait(230);
  }
  maybeSubmit();
}

window.__gyre = {
  reset,
  showSms,
  type,
  fill: () => type(REAL_CODE),
  wrong: (str = '4712') => type(str),
  state: () => state,
  async start() {
    await wait(700);
    showSms();
    await wait(1400);
    await type(REAL_CODE);
  },
};
