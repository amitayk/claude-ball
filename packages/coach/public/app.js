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
  canvas.width = meta.field.width;
  canvas.height = meta.field.height;
  $("scrub").max = String(replay.frames.length - 1);
  $("tag").textContent = payload.tag ?? "current";
  $("score").textContent = `${replay.score.home} – ${replay.score.away}`;
  frameIdx = 0;
  playing = true;
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
  ctx.beginPath(); ctx.arc(W / 2, H / 2, 70, 0, Math.PI * 2); ctx.stroke();

  const top = (H - goalHeight) / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.85)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(4, top); ctx.lineTo(4, top + goalHeight);
  ctx.moveTo(W - 4, top); ctx.lineTo(W - 4, top + goalHeight);
  ctx.stroke();
}

function drawFrame(f) {
  drawPitch();
  let owner = null;
  for (const p of f.players) {
    ctx.beginPath();
    ctx.fillStyle = COLORS[p.side];
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    if (p.ball) {
      owner = p.side;
      ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.fillStyle = COLORS.ball;
  ctx.arc(f.ball.x, f.ball.y, 8, 0, Math.PI * 2);
  ctx.fill();

  $("time").textContent = (f.t * meta.dt).toFixed(1) + "s";
  $("scrub").value = String(frameIdx);
  const poss = $("possession");
  poss.textContent = owner === "home" ? "you on the ball" : owner === "away" ? "opponent on the ball" : "loose ball";
  poss.style.color = owner === "home" ? COLORS.home : owner === "away" ? COLORS.away : "var(--muted)";
}

function loop(now) {
  const dtReal = (now - last) / 1000;
  last = now;
  if (playing && replay) {
    acc += dtReal * Number($("speed").value);
    while (acc >= meta.dt) {
      acc -= meta.dt;
      frameIdx = Math.min(frameIdx + 1, replay.frames.length - 1);
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
$("rerun").addEventListener("click", () => post({ type: "rerun" }));
$("saveParams").addEventListener("click", () => post({ type: "saveParams" }));
$("resetParams").addEventListener("click", () => post({ type: "resetParams" }));
