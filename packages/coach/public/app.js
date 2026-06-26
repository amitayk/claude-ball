// claude-ball · coach — client. Talks to the dev server over SSE (/events) and
// POST /cmd. No build step. The pitch renderer is the original (the coach liked
// it); everything around it is the new cockpit — live telemetry derived here
// from the replay frames, so version previews get the same dashboard.

const $ = (id) => document.getElementById(id);
const canvas = $("pitch");
const ctx = canvas.getContext("2d");

const COLORS = { home: "#4f9dff", away: "#ffd24a", ball: "#fff", line: "rgba(255,255,255,0.22)" };

let replay = null;
let meta = null;
let timeline = [];
let goals = [];
let frameIdx = 0;
let playing = true;
let speed = 1;
let acc = 0;
let last = performance.now();
let paramSpec = {};
let paramValues = {};
let savedValues = {};
let dirtyPending = false;
let youSide = null;
let effects = [];
let shownScore = { home: 0, away: 0 };
let metricsFrames = []; // per-frame custom metrics reported by the brain
let hasMetrics = false;
let lastMetricsRender = "";

// ── commands ──────────────────────────────────────────────────────────────
async function post(cmd) {
  await fetch("/cmd", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(cmd) });
}

// ── SSE ─────────────────────────────────────────────────────────────────────
const es = new EventSource("/events");
es.onopen = () => { $("conn").textContent = "live"; $("conn").classList.add("ok"); };
es.onerror = () => { $("conn").textContent = "reconnecting"; $("conn").classList.remove("ok"); };
es.addEventListener("status", (e) => applyStatus(JSON.parse(e.data)));
es.addEventListener("params", (e) => applyParams(JSON.parse(e.data)));
es.addEventListener("versions", (e) => renderVersions(JSON.parse(e.data)));
es.addEventListener("replay", (e) => applyReplay(JSON.parse(e.data)));
es.addEventListener("error", (e) => showError(JSON.parse(e.data).message));

// ── status / opponent picker ─────────────────────────────────────────────
let oppKey = "";
function applyStatus(s) {
  $("homeName").textContent = s.you;
  $("awayName").textContent = s.opponent;
  $("oppCur").textContent = s.opponentRef;
  $("seed").value = s.seed;
  const key = JSON.stringify(s.opponents) + "::" + s.opponentRef;
  if (oppKey !== key) { oppKey = key; renderOpponents(s.opponents, s.opponentRef); }
  if (s.error) showError(s.error); else hideError();
}

function renderOpponents(opponents, current) {
  const host = $("opponents");
  host.innerHTML = "";
  for (const opp of opponents) {
    const mirror = opp.skill == null;
    const el = document.createElement("button");
    el.className = "opp" + (opp.name === current ? " on" : "") + (mirror ? " mirror" : "");
    const skill = mirror
      ? `<span class="skill-num">↺</span>`
      : `<span class="skill-bar"><span class="skill-fill" style="width:${opp.skill}%"></span></span><span class="skill-num">${opp.skill}</span>`;
    el.innerHTML = `
      <span class="opp-name">${escapeHtml(opp.name)}</span>
      <span class="opp-skill">${skill}</span>
      <span class="opp-blurb">${escapeHtml(opp.blurb)}</span>`;
    el.addEventListener("click", () => {
      host.querySelectorAll(".opp").forEach((o) => o.classList.remove("on"));
      el.classList.add("on");
      $("oppCur").textContent = opp.name;
      setOppOpen(false); // collapse back to the compact bar after picking
      post({ type: "setOpponent", name: opp.name });
    });
    host.appendChild(el);
  }
}

// ── knobs ───────────────────────────────────────────────────────────────────
function applyParams(p) {
  paramSpec = p.spec;
  paramValues = p.values;
  if (!dirtyPending) savedValues = { ...p.values };
  renderKnobs();
  updateDirty();
}

function renderKnobs() {
  const host = $("params");
  const keys = Object.keys(paramSpec);
  if (!keys.length) {
    host.innerHTML = `<p class="hint">No knobs yet. Ask your assistant to expose a value as a <code>param</code> to tune it here.</p>`;
    return;
  }
  host.innerHTML = "";
  for (const key of keys) {
    const spec = paramSpec[key];
    const val = paramValues[key] ?? spec.default;
    const wrap = document.createElement("div");
    wrap.className = "knob";
    wrap.innerHTML = `
      <div class="knob-top"><span class="knob-label">${escapeHtml(spec.label ?? key)}</span><span class="knob-val" id="pv-${key}">${fmt(val)}</span></div>
      <input type="range" id="pr-${key}" min="${spec.min}" max="${spec.max}" step="${spec.step}" value="${val}" />
      ${spec.help ? `<div class="knob-help">${escapeHtml(spec.help)}</div>` : ""}`;
    host.appendChild(wrap);
    const slider = wrap.querySelector("input");
    setFill(slider, spec);
    // While dragging: update the readout live, but DON'T re-run — re-running on
    // every tick resets playback and makes the slider feel shaky.
    slider.addEventListener("input", () => {
      const v = Number(slider.value);
      paramValues[key] = v;
      $(`pv-${key}`).textContent = fmt(v);
      setFill(slider, spec);
      updateDirty();
    });
    // On release (mouseup / keyup / touchend): push once and re-run the match.
    slider.addEventListener("change", () => {
      paramValues[key] = Number(slider.value);
      scheduleParamPush();
    });
  }
}

function setFill(slider, spec) {
  const pct = ((Number(slider.value) - spec.min) / (spec.max - spec.min)) * 100;
  slider.style.setProperty("--fill", `${pct}%`);
}
function updateDirty() {
  const dirty = Object.keys(paramValues).some((k) => paramValues[k] !== savedValues[k]);
  $("dirtyDot").classList.toggle("hidden", !dirty);
}
const fmt = (v) => (Number.isInteger(v) ? String(v) : Number(v).toFixed(2));

let pushTimer = null;
function scheduleParamPush() {
  dirtyPending = true;
  if (pushTimer) clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { post({ type: "setParams", values: paramValues }); dirtyPending = false; }, 110);
}

// ── versions ─────────────────────────────────────────────────────────────────
function renderVersions(versions) {
  const ul = $("versions");
  ul.innerHTML = "";
  if (!versions.length) { ul.innerHTML = `<li class="hint">No commits yet. Commit your brain to build a history.</li>`; return; }
  for (const v of versions) {
    const li = document.createElement("li");
    const when = new Date(v.ts * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    li.innerHTML = `
      <div class="vmeta"><span class="vsubject">${escapeHtml(v.subject)}</span><span class="vtime">${when}</span></div>
      <div class="vsha">${v.sha.slice(0, 7)}</div>
      <div class="vactions"><button class="run" data-run="${v.sha}">▶ Run</button><button data-rollback="${v.sha}">↩ Roll back</button></div>`;
    ul.appendChild(li);
  }
  ul.querySelectorAll("[data-run]").forEach((b) => b.addEventListener("click", () => post({ type: "previewVersion", sha: b.dataset.run })));
  ul.querySelectorAll("[data-rollback]").forEach((b) =>
    b.addEventListener("click", () => { if (confirm("Roll your brain back to this version in the working tree?")) post({ type: "rollback", sha: b.dataset.rollback }); }),
  );
}
const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

// ── replay intake ────────────────────────────────────────────────────────────
function applyReplay(payload) {
  replay = payload.replay;
  meta = replay.meta;
  youSide = payload.you ?? null;
  canvas.width = meta.field.width;
  canvas.height = meta.field.height;

  timeline = buildTimeline(replay);
  goals = findGoals(replay);
  renderMarkers();

  metricsFrames = replay.homeMetrics ?? [];
  hasMetrics = metricsFrames.some(Boolean);
  lastMetricsRender = "";

  $("scrub").max = String(replay.frames.length - 1);
  $("dur").textContent = "/ " + clock((replay.frames.length - 1) * meta.dt);

  const tag = $("buildTag");
  tag.textContent = payload.tag ?? "current";
  tag.classList.remove("flash"); void tag.offsetWidth; tag.classList.add("flash");

  frameIdx = 0; playing = true; effects = [];
  shownScore = { home: 0, away: 0 };
  setScore(0, 0, false);
  $("playpause").textContent = "❚❚";
}

// ── telemetry engine (derived from frames) ────────────────────────────────────
function buildTimeline(rep) {
  const W = rep.meta.field.width;
  const frames = rep.frames;
  const thirdHomeX = W * (2 / 3); // home attacks +x
  const thirdAwayX = W / 3;
  const out = new Array(frames.length);
  const a = { possH: 0, possA: 0, shotsH: 0, shotsA: 0, passH: 0, passA: 0, okH: 0, okA: 0, thirdH: 0, thirdA: 0, distH: 0, distA: 0 };
  let inflight = null, mom = 0, prev = frames[0];

  for (let i = 0; i < frames.length; i++) {
    const f = frames[i], b = f.ball;
    if (b.mode === "controlled") { if (b.side === "home") a.possH++; else if (b.side === "away") a.possA++; }
    if (b.x >= thirdHomeX) a.thirdH++; else if (b.x <= thirdAwayX) a.thirdA++;

    if (i > 0) {
      const pm = prev.ball.mode;
      if ((b.mode === "pass" || b.mode === "shot") && pm === "controlled") {
        const s = prev.ball.side;
        if (b.mode === "shot") { if (s === "home") a.shotsH++; else if (s === "away") a.shotsA++; }
        else { if (s === "home") a.passH++; else if (s === "away") a.passA++; }
        inflight = { type: b.mode, side: s };
      } else if (b.mode === "controlled" && pm !== "controlled" && inflight) {
        if (inflight.type === "pass" && b.side === inflight.side) { if (b.side === "home") a.okH++; else if (b.side === "away") a.okA++; }
        inflight = null;
      }
      for (const p of f.players) {
        const pp = prev.players.find((q) => q.id === p.id);
        if (!pp) continue;
        const d = Math.hypot(p.x - pp.x, p.y - pp.y);
        if (p.side === "home") a.distH += d; else a.distA += d;
      }
    }

    const posFav = b.mode === "controlled" ? (b.side === "home" ? 1 : b.side === "away" ? -1 : 0) : 0;
    const terrFav = (b.x / W - 0.5) * 2;
    mom += (0.6 * posFav + 0.4 * terrFav - mom) * 0.05;

    out[i] = { ...a, mom };
    prev = f;
  }
  return out;
}

function findGoals(rep) {
  const g = [];
  for (let i = 1; i < rep.frames.length; i++) {
    const x = rep.frames[i - 1].score, y = rep.frames[i].score;
    if (y.home > x.home) g.push({ frame: i, side: "home" });
    if (y.away > x.away) g.push({ frame: i, side: "away" });
  }
  return g;
}

function renderMarkers() {
  const host = $("tlMarkers");
  host.innerHTML = "";
  const max = replay.frames.length - 1 || 1;
  for (const g of goals) {
    const m = document.createElement("div");
    m.className = "tl-marker" + (g.side === "away" ? " away" : "");
    m.style.left = (g.frame / max) * 100 + "%";
    m.title = `goal — ${teamLabel(g.side)} @ ${clock(g.frame * meta.dt)}`;
    host.appendChild(m);
  }
}

function updateTelemetry(i) {
  const t = timeline[i];
  if (!t) return;
  const pt = t.possH + t.possA || 1;
  const ph = Math.round((t.possH / pt) * 100);
  $("possHome").style.width = ph + "%";
  $("possAway").style.width = 100 - ph + "%";
  $("possHomeNum").textContent = ph + "%";
  $("possAwayNum").textContent = 100 - ph + "%";

  $("shotsHome").textContent = t.shotsH;
  $("shotsAway").textContent = t.shotsA;
  $("passHome").textContent = t.passH;
  $("passAway").textContent = t.passA;
  $("accHome").textContent = t.passH ? Math.round((t.okH / t.passH) * 100) + "%" : "—";
  $("accAway").textContent = t.passA ? Math.round((t.okA / t.passA) * 100) + "%" : "—";

  const tt = t.thirdH + t.thirdA || 1;
  $("thirdHome").textContent = Math.round((t.thirdH / tt) * 100) + "%";
  $("thirdAway").textContent = Math.round((t.thirdA / tt) * 100) + "%";
  $("distHome").textContent = compact(t.distH);
  $("distAway").textContent = compact(t.distA);

  const m = Math.max(-1, Math.min(1, t.mom));
  const fill = $("momFill");
  if (m >= 0) { fill.style.right = "50%"; fill.style.left = "auto"; fill.style.background = COLORS.home; }
  else { fill.style.left = "50%"; fill.style.right = "auto"; fill.style.background = COLORS.away; }
  fill.style.width = Math.abs(m) * 50 + "%";
}
const compact = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : Math.round(n).toString());

// ════════════════════════════════════════════════════════════════════════════
//  PITCH RENDERING — kept verbatim from the original coach view.
// ════════════════════════════════════════════════════════════════════════════
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

function teamLabel(side) {
  const name = meta?.teams?.[side] ?? side;
  return side === youSide ? `${name} (you)` : name;
}

function drawLabels(W, H, goalHeight) {
  const gTop = (H - goalHeight) / 2;
  ctx.save();
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
    if (p.ball) { ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke(); }
  }
  if (f.phase === "kickoff") drawKickoff(f);
  drawBall(f);
  drawEffects(f);
  syncPlaybackUI(f);
}

function drawKickoff(f) {
  const W = meta.field.width;
  const cx = W / 2, cy = meta.field.height / 2;
  const tint = COLORS[f.kickoffSide];
  ctx.save();
  ctx.strokeStyle = tint; ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
  ctx.beginPath(); ctx.arc(cx, cy, meta.field.centerRadius ?? 70, 0, Math.PI * 2); ctx.stroke();
  ctx.globalAlpha = 1;
  ctx.fillStyle = tint; ctx.font = "bold 14px ui-monospace, monospace";
  ctx.textAlign = "center"; ctx.textBaseline = "bottom";
  ctx.fillText(`KICKOFF — ${teamLabel(f.kickoffSide)}`, cx, cy - (meta.field.centerRadius ?? 70) - 8);
  ctx.restore();
}

function drawBall(f) {
  const { mode, side } = f.ball;
  const tint = side ? COLORS[side] : null;
  const inFlight = mode === "pass" || mode === "shot";
  const TRAIL = inFlight ? 12 : 6;
  const start = Math.max(1, frameIdx - TRAIL);
  ctx.lineCap = "round";
  for (let j = start; j <= frameIdx; j++) {
    const a = replay.frames[j - 1].ball, b = replay.frames[j].ball;
    const t = (j - start + 1) / (frameIdx - start + 1);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = inFlight ? tint ?? "#fff" : "rgba(255,255,255,1)";
    ctx.globalAlpha = (inFlight ? 0.55 : 0.16) * t;
    ctx.lineWidth = inFlight ? (mode === "shot" ? 5 : 4) : 2;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  ctx.beginPath(); ctx.fillStyle = COLORS.ball;
  ctx.arc(f.ball.x, f.ball.y, 8, 0, Math.PI * 2); ctx.fill();
  if (inFlight && tint) { ctx.lineWidth = 3; ctx.strokeStyle = tint; ctx.stroke(); }
  else if (mode === "loose") { ctx.setLineDash([3, 3]); ctx.lineWidth = 2; ctx.strokeStyle = "rgba(255,255,255,0.7)"; ctx.stroke(); ctx.setLineDash([]); }
}

// ── effects ──────────────────────────────────────────────────────────────────
const COLLIDE_DIST = 26, PLAYER_R = 12;
function detectEvents(prev, cur) {
  if ((cur.ball.mode === "pass" || cur.ball.mode === "shot") && prev.ball.mode === "controlled") {
    const kicker = prev.players.find((p) => p.ball);
    spawnEffect({ type: cur.ball.mode, playerId: kicker ? kicker.id : null, color: cur.ball.side ? COLORS[cur.ball.side] : "#fff" });
  }
  for (const a of cur.players) for (const b of cur.players) {
    if (a.side === b.side || a.id >= b.id) continue;
    if (Math.hypot(a.x - b.x, a.y - b.y) >= COLLIDE_DIST) continue;
    const pa = prev.players.find((p) => p.id === a.id), pb = prev.players.find((p) => p.id === b.id);
    const wasApart = !pa || !pb || Math.hypot(pa.x - pb.x, pa.y - pb.y) >= COLLIDE_DIST;
    if (wasApart) { spawnEffect({ type: "collision", playerId: a.id, color: COLORS[a.side] }); spawnEffect({ type: "collision", playerId: b.id, color: COLORS[b.side] }); }
  }
}
function spawnEffect(e) { const life = e.type === "shot" ? 460 : e.type === "pass" ? 340 : 260; effects.push({ ...e, age: 0, life }); if (effects.length > 80) effects.shift(); }
function ageEffects(dtMs) { for (const e of effects) e.age += dtMs; effects = effects.filter((e) => e.age < e.life); }
function drawEffects(frame) {
  for (const e of effects) {
    const p = e.playerId != null ? frame.players.find((pl) => pl.id === e.playerId) : null;
    if (!p) continue;
    const t = e.age / e.life, fade = 1 - t;
    const shot = e.type === "shot", coll = e.type === "collision";
    const grow = shot ? 16 : coll ? 6 : 11;
    const r = PLAYER_R + 2 + t * grow;
    ctx.save();
    ctx.globalAlpha = fade * (shot ? 0.6 : coll ? 0.4 : 0.45);
    ctx.strokeStyle = e.color; ctx.lineWidth = shot ? 3 : 2;
    ctx.shadowColor = e.color; ctx.shadowBlur = shot ? 16 : coll ? 7 : 11;
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }
}

// ── playback UI sync ──────────────────────────────────────────────────────────
function syncPlaybackUI(f) {
  const max = replay.frames.length - 1 || 1;
  $("time").textContent = clock(f.t * meta.dt);
  $("scrub").value = String(frameIdx);
  $("tlFill").style.width = (frameIdx / max) * 100 + "%";

  if (f.score.home !== shownScore.home || f.score.away !== shownScore.away) {
    const scored = f.score.home > shownScore.home ? "home" : "away";
    setScore(f.score.home, f.score.away, true, scored);
    fireGoal(scored);
    shownScore = { ...f.score };
  }

  $("matchClock").textContent = clock(f.t * meta.dt);
  $("phaseTag").textContent = f.phase === "kickoff" ? "kick-off" : "open play";
  updatePossession(f);
  updateTelemetry(frameIdx);
  renderMetrics(frameIdx);
}

// ── "Your metrics": whatever the brain reports via reportMetrics() ────────────
function renderMetrics(i) {
  const host = $("yourMetrics");
  if (!hasMetrics) {
    if (lastMetricsRender !== "empty") {
      lastMetricsRender = "empty";
      host.innerHTML = `<div class="ym-empty">
        Show your brain's own live state here. Tell your assistant
        <em>"report my brain's state to the coach"</em> — it'll call
        <code>reportMetrics({ … })</code> inside <code>decide()</code>, e.g.
        <code>reportMetrics({ phase: state, taker: id })</code>, and the values
        stream into this panel in sync with playback.</div>`;
    }
    return;
  }
  // show the most recent report at or before the current frame
  let m = null;
  for (let j = i; j >= 0; j--) { if (metricsFrames[j]) { m = metricsFrames[j]; break; } }
  const key = m ? JSON.stringify(m) : "none";
  if (key === lastMetricsRender) return;
  lastMetricsRender = key;
  if (!m) { host.innerHTML = `<div class="ym-empty muted">waiting for the first report…</div>`; return; }
  host.innerHTML = Object.entries(m)
    .map(([k, v]) => `<div class="ym-row"><span class="ym-k">${escapeHtml(k)}</span><span class="ym-v">${escapeHtml(String(v))}</span></div>`)
    .join("");
}

function setScore(h, a, pulse, side) {
  $("scoreHome").textContent = h;
  $("scoreAway").textContent = a;
  if (pulse && side) { const el = $(side === "home" ? "scoreHome" : "scoreAway"); el.classList.remove("pulse"); void el.offsetWidth; el.classList.add("pulse"); }
}
function fireGoal(side) {
  const el = $("goalFlash");
  el.textContent = "GOAL";
  el.style.color = COLORS[side];
  el.style.textShadow = `0 0 28px ${COLORS[side]}`;
  el.classList.remove("fire"); void el.offsetWidth; el.classList.add("fire");
}

function updatePossession(f) {
  const poss = $("possession");
  const ball = f.ball;
  if (f.phase === "kickoff") { poss.textContent = `kick-off — ${teamLabel(f.kickoffSide)}`; poss.style.color = COLORS[f.kickoffSide]; return; }
  const who = ball.side ? teamLabel(ball.side) : null;
  const text =
    ball.mode === "controlled" ? `${who} on the ball`
    : ball.mode === "pass" ? `${who} — pass in flight`
    : ball.mode === "shot" ? `${who} — shot away!`
    : "loose ball";
  poss.textContent = text;
  poss.style.color = ball.side ? COLORS[ball.side] : "var(--muted)";
}

const clock = (sec) => { const m = Math.floor(sec / 60), s = Math.floor(sec % 60); return `${m}:${String(s).padStart(2, "0")}`; };

// ── loop ──────────────────────────────────────────────────────────────────────
function loop(now) {
  const dtReal = (now - last) / 1000;
  last = now;
  ageEffects(dtReal * 1000);
  if (playing && replay) {
    acc += dtReal * speed;
    while (acc >= meta.dt) {
      acc -= meta.dt;
      const next = Math.min(frameIdx + 1, replay.frames.length - 1);
      if (next !== frameIdx) detectEvents(replay.frames[frameIdx], replay.frames[next]);
      frameIdx = next;
      if (frameIdx >= replay.frames.length - 1) { playing = false; $("playpause").textContent = "▶"; }
    }
  }
  if (replay) drawFrame(replay.frames[frameIdx]);
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

// ── error toast ────────────────────────────────────────────────────────────────
function showError(msg) { const el = $("error"); el.textContent = "⚠ " + msg; el.classList.remove("hidden"); }
function hideError() { $("error").classList.add("hidden"); }

// ── controls ───────────────────────────────────────────────────────────────────
function togglePlay() {
  if (!replay) return;
  if (frameIdx >= replay.frames.length - 1) { frameIdx = 0; shownScore = { home: 0, away: 0 }; }
  playing = !playing;
  $("playpause").textContent = playing ? "❚❚" : "▶";
}
$("playpause").addEventListener("click", togglePlay);
$("restart").addEventListener("click", () => { frameIdx = 0; acc = 0; shownScore = { home: 0, away: 0 }; effects = []; setScore(0, 0, false); });
$("scrub").addEventListener("input", () => {
  frameIdx = Number($("scrub").value);
  playing = false; $("playpause").textContent = "▶";
  shownScore = { ...replay.frames[frameIdx].score };
  setScore(shownScore.home, shownScore.away, false);
});
$("speedSeg").addEventListener("click", (e) => {
  const b = e.target.closest("button"); if (!b) return;
  speed = Number(b.dataset.speed);
  $("speedSeg").querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
});
// opponent picker collapse (collapsed by default)
function setOppOpen(open) {
  document.querySelector(".opp-card").classList.toggle("open", open);
  $("oppBody").classList.toggle("hidden", !open);
}
$("oppToggle").addEventListener("click", () => setOppOpen($("oppBody").classList.contains("hidden")));

$("seed").addEventListener("change", () => post({ type: "setSeed", seed: Number($("seed").value) }));
$("randomSeed").addEventListener("click", () => { const s = Math.floor(Math.random() * 1_000_000) + 1; $("seed").value = s; post({ type: "setSeed", seed: s }); });
$("rerun").addEventListener("click", () => post({ type: "rerun" }));
$("saveParams").addEventListener("click", () => { savedValues = { ...paramValues }; updateDirty(); post({ type: "saveParams" }); });
$("resetParams").addEventListener("click", () => post({ type: "resetParams" }));

document.addEventListener("keydown", (e) => {
  // Space toggles play/pause from anywhere on the page, whatever has focus.
  // preventDefault stops both page scroll and a focused button re-firing.
  if (e.code === "Space") { e.preventDefault(); togglePlay(); if (e.target.blur) e.target.blur(); return; }
  if (e.target.tagName === "INPUT") return;
  if (e.code === "ArrowRight" && replay) { playing = false; $("playpause").textContent = "▶"; frameIdx = Math.min(frameIdx + 1, replay.frames.length - 1); }
  else if (e.code === "ArrowLeft" && replay) { playing = false; $("playpause").textContent = "▶"; frameIdx = Math.max(frameIdx - 1, 0); }
});
