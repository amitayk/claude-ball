// Coach workbench client. Talks to the dev server over SSE (/events) and
// POST /cmd. No build step.
const $ = (id) => document.getElementById(id);
const canvas = $("pitch");
const ctx = canvas.getContext("2d");

const COLORS = { home: "#4f9dff", away: "#ff7a59", ball: "#fff", line: "rgba(255,255,255,0.22)" };

let replay = null;
let meta = null;
let frameIdx = 0;
let playing = true;
let acc = 0;
let last = performance.now();
let paramSpec = {};
let paramValues = {};
// Which side the local coach controls ("home" | "away" | null). Only used to
// annotate "(you)"; nothing about left/right/own-goal is tied to it, so a PvP
// spectator (you = null) renders the same labels minus the marker.
let youSide = null;
// transient visual effects (collisions, pass/shoot flashes); aged in real time
let effects = [];

// ── commands ────────────────────────────────────────────────────────────────
async function post(cmd) {
  await fetch("/cmd", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
}

// ── SSE ───────────────────────────────────────────────────────────────────────
const es = new EventSource("/events");
es.onopen = () => {
  $("conn").textContent = "● live";
  $("conn").classList.add("ok");
};
es.onerror = () => {
  $("conn").textContent = "○ reconnecting";
  $("conn").classList.remove("ok");
};
es.addEventListener("status", (e) => applyStatus(JSON.parse(e.data)));
es.addEventListener("params", (e) => applyParams(JSON.parse(e.data)));
es.addEventListener("versions", (e) => renderVersions(JSON.parse(e.data)));
es.addEventListener("replay", (e) => applyReplay(JSON.parse(e.data)));
es.addEventListener("error", (e) => showError(JSON.parse(e.data).message));

// ── status ──────────────────────────────────────────────────────────────────
function applyStatus(s) {
  $("homeName").textContent = s.you;
  $("awayName").textContent = s.opponent;
  if (s.score) $("score").textContent = `${s.score.home} – ${s.score.away}`;
  $("seed").value = s.seed;

  const sel = $("opponent");
  if (sel.dataset.list !== JSON.stringify(s.opponents)) {
    sel.dataset.list = JSON.stringify(s.opponents);
    sel.innerHTML = "";
    for (const name of s.opponents) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      sel.appendChild(o);
    }
  }
  sel.value = s.opponentRef;
  if (s.error) showError(s.error);
  else hideError();
}

// ── params control panel ───────────────────────────────────────────────────────
function applyParams(p) {
  paramSpec = p.spec;
  paramValues = p.values;
  renderParams();
}

function renderParams() {
  const host = $("params");
  const keys = Object.keys(paramSpec);
  if (!keys.length) {
    host.innerHTML = `<p class="muted small">This brain declares no params. Ask your assistant to expose a value as a param to tune it here.</p>`;
    return;
  }
  host.innerHTML = "";
  for (const key of keys) {
    const spec = paramSpec[key];
    const val = paramValues[key] ?? spec.default;
    const wrap = document.createElement("div");
    wrap.className = "param";
    wrap.innerHTML = `
      <div class="plabel"><span>${spec.label ?? key}</span><span class="pval" id="pv-${key}">${fmt(val)}</span></div>
      <input type="range" id="pr-${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${val}" />`;
    host.appendChild(wrap);
    const slider = wrap.querySelector("input");
    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      paramValues[key] = v;
      $(`pv-${key}`).textContent = fmt(v);
      scheduleParamPush();
    });
  }
}

const fmt = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(2));

let pushTimer = null;
function scheduleParamPush() {
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => post({ type: "setParams", values: paramValues }), 120);
}

// ── versions ──────────────────────────────────────────────────────────────────
function renderVersions(versions) {
  const ul = $("versions");
  ul.innerHTML = "";
  if (!versions.length) {
    ul.innerHTML = `<li class="muted small">No commits yet. Commit your brain to build a history.</li>`;
    return;
  }
  for (const v of versions) {
    const li = document.createElement("li");
    const when = new Date(v.ts * 1000).toLocaleString();
    li.innerHTML = `
      <div class="vmeta"><span class="vsubject">${escape(v.subject)}</span><span class="vtime">${when}</span></div>
      <div class="sha">${v.sha.slice(0, 7)}</div>
      <div class="vactions">
        <button data-run="${v.sha}">▶ Run this</button>
        <button data-rollback="${v.sha}" class="ghost">↩ Roll back</button>
      </div>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll("[data-run]").forEach((b) =>
    b.addEventListener("click", () => post({ type: "previewVersion", sha: b.dataset.run })),
  );
  ul.querySelectorAll("[data-rollback]").forEach((b) =>
    b.addEventListener("click", () => {
      if (confirm("Roll your brain back to this version in the working tree?"))
        post({ type: "rollback", sha: b.dataset.rollback });
    }),
  );
}

const escape = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]);

// ── replay playback ─────────────────────────────────────────────────────────────
function applyReplay(payload) {
  replay = payload.replay;
  meta = replay.meta;
  youSide = payload.you ?? null;
  canvas.width = meta.field.width;
  canvas.height = meta.field.height;
  $("scrub").max = String(replay.frames.length - 1);
  $("tag").textContent = payload.tag ?? "current";
  $("score").textContent = `${replay.score.home} – ${replay.score.away}`;
  frameIdx = 0;
  playing = true;
  effects = [];
  $("playpause").textContent = "⏸";
}

function drawAxis(W, H) {
  ctx.strokeStyle = COLORS.line;
  ctx.fillStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;
  ctx.font = "11px ui-monospace, monospace";
  for (let x = 0; x <= W; x += 150) {
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.fillText(String(x), x + 3, 13);
  }
  for (let y = 0; y <= H; y += 150) {
    ctx.globalAlpha = 0.5;
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke();
    ctx.globalAlpha = 1;
    if (y > 0) ctx.fillText(String(y), 3, y - 4);
  }
}

function drawPitch() {
  const { width: W, height: H, goalHeight } = meta.field;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = "#15602f";
  ctx.fillRect(0, 0, W, H);
  drawAxis(W, H);

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, W - 16, H - 16);
  ctx.beginPath(); ctx.moveTo(W / 2, 8); ctx.lineTo(W / 2, H - 8); ctx.stroke();
  ctx.beginPath(); ctx.arc(W / 2, H / 2, meta.field.centerRadius ?? 70, 0, Math.PI * 2); ctx.stroke();

  const top = (H - goalHeight) / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(4, top); ctx.lineTo(4, top + goalHeight);
  ctx.moveTo(W - 4, top); ctx.lineTo(W - 4, top + goalHeight);
  ctx.stroke();

  drawLabels(W, H, goalHeight);
}

// Display label for a side: its team name, plus a "(you)" marker only when the
// local coach controls that side. Side-agnostic — no "your/enemy" baked in.
function teamLabel(side) {
  const name = meta?.teams?.[side] ?? side;
  return side === youSide ? `${name} (you)` : name;
}

// Field labels reference each TEAM (by name + the goal it defends + the way it
// attacks), never "your/enemy". The home slot defends the x=0 goal and attacks
// toward +x; the away slot is the mirror. LEFT/RIGHT/TOP/BOTTOM below are
// coordinate facts about the pitch, not team ownership.
function drawLabels(W, H, goalHeight) {
  const gTop = (H - goalHeight) / 2;
  ctx.save();
  // each goal tinted in the colour of the team that DEFENDS it
  ctx.globalAlpha = 0.16;
  ctx.fillStyle = COLORS.home; ctx.fillRect(4, gTop, 22, goalHeight);
  ctx.fillStyle = COLORS.away; ctx.fillRect(W - 26, gTop, 22, goalHeight);
  ctx.globalAlpha = 1;

  ctx.textBaseline = "top";
  ctx.font = "bold 15px ui-monospace, monospace";
  ctx.fillStyle = COLORS.home; ctx.textAlign = "left";
  ctx.fillText(`${teamLabel("home")}  attacks ▶`, 34, 26);
  ctx.fillStyle = COLORS.away; ctx.textAlign = "right";
  ctx.fillText(`◀ attacks  ${teamLabel("away")}`, W - 16, 26);

  ctx.fillStyle = "rgba(255,255,255,0.5)";
  ctx.font = "12px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "top";
  ctx.fillText("y = 0 (top edge)", W / 2, 26);
  ctx.textBaseline = "bottom";
  ctx.fillText("y = " + H + " (bottom edge)   ·   x → right   ·   y ↓ down", W / 2, H - 10);
  ctx.textBaseline = "middle";
  ctx.textAlign = "left"; ctx.fillText("x = 0", 30, H / 2);
  ctx.textAlign = "right"; ctx.fillText("x = " + W, W - 30, H / 2);
  ctx.restore();
}

function drawFrame(f) {
  drawPitch();
  for (const p of f.players) {
    ctx.beginPath();
    ctx.fillStyle = COLORS[p.side];
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    if (p.ball) {
      ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }
  if (f.phase === "kickoff") drawKickoff(f);
  drawBall(f);
  drawEffects();

  $("time").textContent = (f.t * meta.dt).toFixed(1) + "s";
  $("scrub").value = String(frameIdx);
  updatePossession(f);
}

// Emphasise the centre circle in the kicking team's colour and badge the phase.
function drawKickoff(f) {
  const W = meta.field.width;
  const cx = W / 2;
  const cy = meta.field.height / 2;
  const tint = COLORS[f.kickoffSide];
  ctx.save();
  ctx.strokeStyle = tint;
  ctx.lineWidth = 3;
  ctx.globalAlpha = 0.9;
  ctx.beginPath();
  ctx.arc(cx, cy, meta.field.centerRadius ?? 70, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = tint;
  ctx.font = "bold 14px ui-monospace, monospace";
  ctx.textAlign = "center";
  ctx.textBaseline = "bottom";
  ctx.fillText(`KICKOFF — ${teamLabel(f.kickoffSide)}`, cx, cy - (meta.field.centerRadius ?? 70) - 8);
  ctx.restore();
}

// Render the ball according to its mode: a team-coloured motion trail + tinted
// outline while a pass/shot is in flight; a neutral dashed ring when the ball
// is genuinely loose (contestable); plain when a player controls it.
function drawBall(f) {
  const { mode, side } = f.ball;
  const tint = side ? COLORS[side] : null;
  const inFlight = mode === "pass" || mode === "shot";

  // motion trail from the previous frames toward the current position
  const TRAIL = inFlight ? 12 : 6;
  const start = Math.max(1, frameIdx - TRAIL);
  ctx.lineCap = "round";
  for (let j = start; j <= frameIdx; j++) {
    const a = replay.frames[j - 1].ball;
    const b = replay.frames[j].ball;
    const t = (j - start + 1) / (frameIdx - start + 1);
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = inFlight ? tint ?? "#fff" : "rgba(255,255,255,1)";
    ctx.globalAlpha = (inFlight ? 0.55 : 0.16) * t;
    ctx.lineWidth = inFlight ? (mode === "shot" ? 5 : 4) : 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  ctx.beginPath();
  ctx.fillStyle = COLORS.ball;
  ctx.arc(f.ball.x, f.ball.y, 8, 0, Math.PI * 2);
  ctx.fill();
  if (inFlight && tint) {
    ctx.lineWidth = 3;
    ctx.strokeStyle = tint;
    ctx.stroke();
  } else if (mode === "loose") {
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 2;
    ctx.strokeStyle = "rgba(255,255,255,0.7)";
    ctx.stroke();
    ctx.setLineDash([]);
  }
}

// ── effects ───────────────────────────────────────────────────────────────────
const hexToRgba = (hex, a) => {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};

const COLLIDE_DIST = 26; // ~2 × player radius (+ a little)

// Compare two adjacent frames and spawn effects for events that just happened.
function detectEvents(prev, cur) {
  // Kick: the ball goes from controlled to a pass/shot this tick.
  if ((cur.ball.mode === "pass" || cur.ball.mode === "shot") && prev.ball.mode === "controlled") {
    spawnEffect({
      type: cur.ball.mode,
      x: cur.ball.x,
      y: cur.ball.y,
      color: cur.ball.side ? COLORS[cur.ball.side] : "#ffffff",
    });
  }
  // Collision: opposing players that just came into contact.
  for (const a of cur.players) {
    for (const b of cur.players) {
      if (a.side === b.side || a.id >= b.id) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) >= COLLIDE_DIST) continue;
      const pa = prev.players.find((p) => p.id === a.id);
      const pb = prev.players.find((p) => p.id === b.id);
      const wasApart = !pa || !pb || Math.hypot(pa.x - pb.x, pa.y - pb.y) >= COLLIDE_DIST;
      if (wasApart) spawnEffect({ type: "collision", x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, color: "#ffe08a" });
    }
  }
}

function spawnEffect(e) {
  const life = e.type === "shot" ? 480 : e.type === "pass" ? 340 : 260;
  effects.push({ ...e, age: 0, life });
  if (effects.length > 80) effects.shift();
}

function ageEffects(dtRealMs) {
  for (const e of effects) e.age += dtRealMs;
  effects = effects.filter((e) => e.age < e.life);
}

function drawEffects() {
  for (const e of effects) {
    const t = e.age / e.life; // 0 → 1
    const fade = 1 - t;
    if (e.type === "collision") {
      // a small, quick spark burst at the point of contact
      const r = 4 + t * 16;
      ctx.save();
      ctx.globalAlpha = fade * 0.9;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
      for (let i = 0; i < 5; i++) {
        const ang = (i / 5) * Math.PI * 2;
        ctx.beginPath();
        ctx.moveTo(e.x + Math.cos(ang) * (r * 0.6), e.y + Math.sin(ang) * (r * 0.6));
        ctx.lineTo(e.x + Math.cos(ang) * (r + 3), e.y + Math.sin(ang) * (r + 3));
        ctx.stroke();
      }
      ctx.restore();
    } else {
      // pass/shoot: a glow + an expanding light ring (shots are bigger/brighter)
      const shot = e.type === "shot";
      const maxR = shot ? 56 : 30;
      const r = 8 + t * maxR;
      ctx.save();
      const grad = ctx.createRadialGradient(e.x, e.y, 0, e.x, e.y, r);
      grad.addColorStop(0, hexToRgba(e.color, fade * (shot ? 0.55 : 0.34)));
      grad.addColorStop(1, hexToRgba(e.color, 0));
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = fade * (shot ? 0.95 : 0.6);
      ctx.strokeStyle = e.color;
      ctx.lineWidth = shot ? 4 : 2.5;
      ctx.beginPath();
      ctx.arc(e.x, e.y, r, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }
  }
}

function updatePossession(f) {
  const poss = $("possession");
  const ball = f.ball;
  if (f.phase === "kickoff") {
    poss.textContent = `kickoff — ${teamLabel(f.kickoffSide)}`;
    poss.style.color = COLORS[f.kickoffSide];
    return;
  }
  const who = ball.side ? teamLabel(ball.side) : null;
  const text =
    ball.mode === "controlled" ? `${who} on the ball`
    : ball.mode === "pass" ? `${who} — pass in flight`
    : ball.mode === "shot" ? `${who} — shot in flight`
    : "loose ball";
  poss.textContent = text;
  poss.style.color = ball.side ? COLORS[ball.side] : "var(--muted)";
}

function loop(now) {
  const dtReal = (now - last) / 1000;
  last = now;
  ageEffects(dtReal * 1000);
  if (playing && replay) {
    acc += dtReal * Number($("speed").value);
    while (acc >= meta.dt) {
      acc -= meta.dt;
      const next = Math.min(frameIdx + 1, replay.frames.length - 1);
      if (next !== frameIdx) detectEvents(replay.frames[frameIdx], replay.frames[next]);
      frameIdx = next;
      if (frameIdx >= replay.frames.length - 1) playing = false, ($("playpause").textContent = "▶");
    }
  }
  if (replay) drawFrame(replay.frames[frameIdx]);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── error toast ────────────────────────────────────────────────────────────────
function showError(msg) {
  const el = $("error");
  el.textContent = "⚠ " + msg;
  el.classList.remove("hidden");
}
function hideError() {
  $("error").classList.add("hidden");
}

// ── controls ───────────────────────────────────────────────────────────────────
$("playpause").addEventListener("click", () => {
  if (frameIdx >= replay.frames.length - 1) frameIdx = 0;
  playing = !playing;
  $("playpause").textContent = playing ? "⏸" : "▶";
});
$("scrub").addEventListener("input", () => {
  frameIdx = Number($("scrub").value);
  playing = false;
  $("playpause").textContent = "▶";
});
$("opponent").addEventListener("change", () => post({ type: "setOpponent", name: $("opponent").value }));
$("seed").addEventListener("change", () => post({ type: "setSeed", seed: Number($("seed").value) }));
$("randomSeed").addEventListener("click", () => {
  const s = Math.floor(Math.random() * 1_000_000) + 1;
  $("seed").value = s;
  post({ type: "setSeed", seed: s });
});
$("rerun").addEventListener("click", () => post({ type: "rerun" }));
$("saveParams").addEventListener("click", () => post({ type: "saveParams" }));
$("resetParams").addEventListener("click", () => post({ type: "resetParams" }));
