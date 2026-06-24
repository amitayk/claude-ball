import { MatchPlayer } from "./match.js";
import { BRAND, REPO } from "./brand.js";

// House bots + engine bundled for the browser, so house-vs-house matchups can be
// re-simulated live when a visitor turns a knob. Loaded lazily and defensively:
// if the bundle is missing (not built), knob tuning just stays hidden.
let houseBots = {};
try { ({ houseBots } = await import("./sim.bundle.js")); } catch { /* no live tuning */ }

// Brand the page from one const.
document.title = `${BRAND} · the arena`;
{
  const star = document.getElementById("starBtn");
  if (star) star.href = REPO;
}

// API base: ?api=<url> (persisted) > window.KR_API > saved > localhost. Lets the
// static web app be deployed once and pointed at any arena.
const initParams = new URLSearchParams(location.search);
const qApi = initParams.get("api");
if (qApi) localStorage.setItem("kr_api", qApi);
// Shareable matchup state: ?home=<bot>&away=<bot>&seed=<n>
const initHome = initParams.get("home");
const initAway = initParams.get("away");
const initSeed = initParams.get("seed");
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
// In production the API serves this page, so default to same-origin ("").
const API = window.KR_API ?? qApi ?? localStorage.getItem("kr_api") ?? (isLocal ? "http://localhost:8787" : "");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const MEDAL = ["🥇", "🥈", "🥉"];

$("apihint").textContent = API || location.origin;

const player = new MatchPlayer($("pitch"));
player.onTick = (i, n) => {
  $("scrub").max = String(Math.max(0, n - 1));
  $("scrub").value = String(i);
  if (player.replay) $("ttime").textContent = (player.replay.frames[i].t * player.meta.dt).toFixed(1) + "s";
  $("pp").textContent = player.playing ? "⏸" : "▶";
};

let bots = [];
let firstLoad = true;
let picks = []; // selected bot names, ordered; [home, away]

async function refresh() {
  try {
    const res = await fetch(`${API}/api/leaderboard`, { cache: "no-store" });
    bots = (await res.json()).bots || [];
    renderBoard();
    syncSelects();
    renderPicks();
    updateBotName();
    $("conn").textContent = "live";
    $("conn").classList.add("ok");
    if (firstLoad && bots.length >= 1) {
      firstLoad = false;
      const has = (n) => !!n && bots.some((b) => b.name === n);
      let home, away;
      if (has(initHome)) {
        home = initHome;
        away = has(initAway) ? initAway : home === "blitz" ? "formation" : "blitz";
      } else {
        home = has("blitz") ? "blitz" : bots[0].name;
        away = has("formation") ? "formation" : bots.find((b) => b.name !== home)?.name ?? home;
      }
      if (!has(away) || away === home) away = bots.find((b) => b.name !== home)?.name ?? home;
      if (initSeed && /^\d+$/.test(initSeed)) $("seedInput").value = initSeed;
      setMatchup(home, away);
    }
  } catch {
    $("conn").textContent = "offline";
    $("conn").classList.remove("ok");
  }
}

function renderBoard() {
  $("count").textContent = `${bots.length} bots`;
  const elos = bots.map((b) => b.elo);
  const max = Math.max(1, ...elos), min = Math.min(...elos), span = Math.max(1, max - min);
  $("rows").innerHTML = bots
    .map((b, i) => {
      const isUser = b.kind === "user";
      const medal = i < 3 ? MEDAL[i] : i + 1;
      const pill = isUser ? `<span class="pill you">challenger</span>` : `<span class="pill lib">house</span>`;
      const wdl = b.record ? `${b.record.wins}-${b.record.draws}-${b.record.losses}` : "-";
      const fill = Math.round(((b.elo - min) / span) * 100);
      const blurb = b.blurb ? `<div class="blurb">${esc(b.blurb)}</div>` : "";
      return `<li class="row" data-name="${esc(b.name)}">
        <div class="rank ${i < 3 ? "m" + (i + 1) : ""}">${medal}</div>
        <div class="who"><div class="name">${esc(cap(b.name))} ${pill} <span class="selbadge"></span></div>
          <div class="owner">${isUser ? "@" + esc(b.handle) : "house"} · <span class="wdl">${wdl}</span></div>${blurb}</div>
        <div class="stat"><div class="elo">${b.elo}</div><div class="elocap">strength</div><div class="elobar"><span style="width:${fill}%"></span></div></div>
      </li>`;
    })
    .join("");
  for (const li of document.querySelectorAll(".row")) {
    li.addEventListener("click", () => clickRow(li.dataset.name));
  }
}

function syncSelects() {
  for (const sel of [$("homeSel"), $("awaySel")]) {
    const keep = sel.value;
    sel.innerHTML = bots.map((b) => `<option value="${esc(b.name)}">${esc(cap(b.name))} · strength ${b.elo}</option>`).join("");
    if (bots.some((b) => b.name === keep)) sel.value = keep;
  }
}

// ---------- selection: pick two bots, auto-run ----------
function setMatchup(home, away, run = true) {
  picks = [home, away];
  $("homeSel").value = home;
  $("awaySel").value = away;
  renderPicks();
  renderKnobs(home, away); // fresh knob panels for the new matchup
  if (run) watch();
}

function clickRow(name) {
  const idx = picks.indexOf(name);
  if (idx >= 0) picks.splice(idx, 1);       // click a selected bot to drop it
  else if (picks.length < 2) picks.push(name);
  else picks = [name];                      // already have two -> start fresh
  if (picks.length === 2) setMatchup(picks[0], picks[1]);
  else renderPicks();
}

function renderPicks() {
  for (const li of document.querySelectorAll(".row")) {
    const i = picks.indexOf(li.dataset.name);
    li.classList.toggle("sel", i >= 0);
    li.classList.toggle("selHome", i === 0);
    li.classList.toggle("selAway", i === 1);
    const badge = li.querySelector(".selbadge");
    if (badge) badge.textContent = i === 0 ? "HOME" : i === 1 ? "AWAY" : "";
  }
  const s = $("boardSel");
  if (picks.length === 0) s.textContent = "Click two bots to watch them play - 0 selected";
  else if (picks.length === 1) s.innerHTML = `<b>${esc(cap(picks[0]))}</b> selected - pick an opponent`;
  else s.innerHTML = `<b class="cH">${esc(cap(picks[0]))}</b> vs <b class="cA">${esc(cap(picks[1]))}</b>`;
  // a prompt next to the leaderboard title once exactly one bot is picked
  $("boardHint").textContent = picks.length === 1 ? "choose a second bot" : "";
}

function updateUrl(home, away, seed) {
  const p = new URLSearchParams(location.search);
  p.set("home", home); p.set("away", away); p.set("seed", String(seed));
  // keep shared links reproducible: encode any non-default knob overrides
  const ho = overridesFor("home", home), ao = overridesFor("away", away);
  ho ? p.set("homeParams", JSON.stringify(ho)) : p.delete("homeParams");
  ao ? p.set("awayParams", JSON.stringify(ao)) : p.delete("awayParams");
  history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
}

// ---------- live knob tuning ----------
// Each side's current slider values (defaults unless turned). `overridesFor`
// returns only what differs from default — used for the URL and the server path.
const knobVals = { home: {}, away: {} };
// Shared-link knob values to apply on the very first render (consumed once).
const parseKnobs = (s) => { try { const o = JSON.parse(s); return o && typeof o === "object" ? o : null; } catch { return null; } };
let pendingUrlKnobs = (initParams.get("homeParams") || initParams.get("awayParams"))
  ? { home: parseKnobs(initParams.get("homeParams")), away: parseKnobs(initParams.get("awayParams")) }
  : null;

const clampSpec = (v, s) => Math.max(s.min, Math.min(s.max, v));
function fmtVal(v, step) {
  if (!isFinite(step) || step >= 1) return String(Math.round(v));
  const dec = (String(step).split(".")[1] || "").length;
  return v.toFixed(Math.min(dec || 2, 4));
}
function overridesFor(side, name) {
  const spec = houseBots[name]?.params;
  if (!spec) return undefined;
  const cur = knobVals[side] || {}, out = {};
  for (const k of Object.keys(spec)) {
    if (cur[k] !== undefined && cur[k] !== spec[k].default) out[k] = cur[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function buildSide(side, name) {
  const listEl = $(side === "home" ? "knobsHome" : "knobsAway");
  $(side === "home" ? "knobsHomeName" : "knobsAwayName").textContent = cap(name);
  const spec = houseBots[name]?.params;
  knobVals[side] = {};
  if (!spec || !Object.keys(spec).length) {
    listEl.innerHTML = houseBots[name]
      ? `<div class="knobs-empty">No knobs — this bot exposes none.</div>`
      : `<div class="knobs-empty">Challenger bot — its knobs are private.</div>`;
    return 0;
  }
  const keys = Object.keys(spec);
  for (const k of keys) knobVals[side][k] = spec[k].default;
  // apply shared-link overrides on first render
  const pv = pendingUrlKnobs?.[side];
  if (pv) for (const k of keys) if (typeof pv[k] === "number") knobVals[side][k] = clampSpec(pv[k], spec[k]);

  listEl.innerHTML = keys.map((k) => {
    const s = spec[k], cur = knobVals[side][k], changed = cur !== s.default;
    return `<div class="knob${changed ? " changed" : ""}" data-side="${side}" data-key="${esc(k)}" title="${esc(s.help)}">
      <div class="knob-top"><span class="knob-label">${esc(s.label || k)}</span><span class="knob-val">${fmtVal(cur, s.step)}</span></div>
      <input type="range" min="${s.min}" max="${s.max}" step="${s.step}" value="${cur}" aria-label="${esc(s.label || k)}">
      <div class="knob-help">${esc(s.help)}</div>
    </div>`;
  }).join("");

  for (const row of listEl.querySelectorAll(".knob")) {
    const inp = row.querySelector("input"), key = row.dataset.key;
    inp.addEventListener("input", () => {
      const v = Number(inp.value);
      knobVals[side][key] = v;
      row.querySelector(".knob-val").textContent = fmtVal(v, Number(inp.step));
      row.classList.toggle("changed", v !== spec[key].default);
      updateResetVisible();
      scheduleResim();
    });
  }
  return keys.length;
}

function renderKnobs(home, away) {
  if (!$("knobsTab")) return;
  const total = buildSide("home", home) + buildSide("away", away);
  pendingUrlKnobs = null; // shared-link values are a one-time apply
  const hasKnobs = total > 0;
  // The Knobs tab + "Coach live" shortcut only exist when there's something to tune.
  $("knobsTab").hidden = !hasKnobs;
  $("coachBtn").hidden = !hasKnobs;
  $("knobsTabCount").textContent = hasKnobs ? `(${total})` : "";
  const bothHouse = !!(houseBots[home] && houseBots[away]);
  $("knobsNote").textContent = bothHouse
    ? "Runs instantly in your browser."
    : "Tuning a house bot re-runs on the server (~1–2s).";
  if (!hasKnobs && currentTab === "knobs") switchTab("board"); // nothing to tune → back to board
  updateResetVisible();
}

// ---------- sidebar tabs ----------
let currentTab = "board";
function switchTab(tab) {
  if (tab === "knobs" && $("knobsTab").hidden) return; // no knobs to show
  currentTab = tab;
  for (const b of document.querySelectorAll("#sidebarTabs button")) b.classList.toggle("active", b.dataset.tab === tab);
  for (const p of document.querySelectorAll(".board .tabpanel")) p.hidden = p.dataset.panel !== tab;
  $("coachBtn").classList.toggle("active", tab === "knobs");
}
for (const b of document.querySelectorAll("#sidebarTabs button")) b.addEventListener("click", () => switchTab(b.dataset.tab));
$("coachBtn").addEventListener("click", () => switchTab("knobs"));

function updateResetVisible() {
  const changed = !!(overridesFor("home", $("homeSel").value) || overridesFor("away", $("awaySel").value));
  $("knobsReset").hidden = !changed;
}

function resetKnobs() {
  for (const side of ["home", "away"]) {
    const name = side === "home" ? $("homeSel").value : $("awaySel").value;
    const spec = houseBots[name]?.params;
    if (!spec) continue;
    const listEl = $(side === "home" ? "knobsHome" : "knobsAway");
    for (const row of listEl.querySelectorAll(".knob")) {
      const k = row.dataset.key, d = spec[k].default, inp = row.querySelector("input");
      knobVals[side][k] = d;
      inp.value = String(d);
      row.querySelector(".knob-val").textContent = fmtVal(d, Number(inp.step));
      row.classList.remove("changed");
    }
  }
  updateResetVisible();
  scheduleResim();
}
$("knobsReset").addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); resetKnobs(); });

// ---------- match running: house-vs-house runs in-browser; otherwise the server ----------
let simWorker = null, simSeq = 0;
const simPending = new Map();
function clientSim(home, away, seed, homeParams, awayParams) {
  if (!simWorker) {
    simWorker = new Worker(new URL("./sim.worker.js", import.meta.url), { type: "module" });
    simWorker.onmessage = (e) => {
      const { id, ok, replay, error } = e.data, p = simPending.get(id);
      if (!p) return;
      simPending.delete(id);
      ok ? p.resolve(replay) : p.reject(new Error(error || "sim failed"));
    };
    simWorker.onerror = () => { for (const p of simPending.values()) p.reject(new Error("sim worker error")); simPending.clear(); };
  }
  const id = ++simSeq;
  return new Promise((resolve, reject) => {
    simPending.set(id, { resolve, reject });
    simWorker.postMessage({ id, home, away, seed: Number(seed) || 1, homeParams, awayParams });
  });
}

// Run the current matchup with current knobs. Returns { replay, homeName, awayName }.
async function simulate(home, away, seed) {
  const hp = overridesFor("home", home), ap = overridesFor("away", away);
  if (houseBots[home] && houseBots[away]) {
    const replay = await clientSim(home, away, seed, hp, ap);
    return { replay, homeName: cap(home), awayName: cap(away) };
  }
  const qs = new URLSearchParams({ home, away, seed: String(seed) });
  if (hp) qs.set("homeParams", JSON.stringify(hp));
  if (ap) qs.set("awayParams", JSON.stringify(ap));
  const res = await fetch(`${API}/api/watch?${qs.toString()}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "match failed");
  return { replay: data.replay, homeName: cap(data.home.name), awayName: cap(data.away.name) };
}

let runToken = 0; // newest run wins; stale async results are discarded

async function watch() {
  const home = $("homeSel").value, away = $("awaySel").value, seed = $("seedInput").value || 1;
  if (!home || !away) return;
  updateUrl(home, away, seed);
  const token = ++runToken;
  const btn = $("watchBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Running…";
  $("stageMsg").className = "stagemsg loading";
  $("stageMsg").textContent = "running match…";
  try {
    const { replay, homeName, awayName } = await simulate(home, away, seed);
    if (token !== runToken) return; // superseded by a newer run
    player.load(replay, { home: homeName, away: awayName });
    $("stageMsg").className = "stagemsg"; $("stageMsg").textContent = "";
  } catch (e) {
    if (token !== runToken) return;
    $("stageMsg").className = "stagemsg err"; $("stageMsg").textContent = e?.message || "couldn't run the match";
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// Re-run after a knob change. The match is a brand-new game, so we restart it
// from kickoff (player.load resets to frame 0 and plays) and flash a notice —
// making it obvious that turning a knob re-runs the whole match.
async function resim() {
  const home = $("homeSel").value, away = $("awaySel").value, seed = $("seedInput").value || 1;
  if (!home || !away) return;
  updateUrl(home, away, seed);
  const token = ++runToken;
  const serverPath = !(houseBots[home] && houseBots[away]);
  $("stageMsg").className = serverPath ? "stagemsg loading" : "stagemsg flash";
  $("stageMsg").textContent = serverPath ? "↻ re-running on server…" : "↻ re-running from kickoff…";
  try {
    const { replay, homeName, awayName } = await simulate(home, away, seed);
    if (token !== runToken) return;
    player.load(replay, { home: homeName, away: awayName }); // restarts from kickoff, autoplays
    flashRestart(token);
  } catch (e) {
    if (token !== runToken) return;
    $("stageMsg").className = "stagemsg err"; $("stageMsg").textContent = e?.message || "re-run failed";
  }
}

// Briefly show a "restarted" notice on the field, then clear it (unless a newer run took over).
function flashRestart(token) {
  $("stageMsg").className = "stagemsg flash";
  $("stageMsg").textContent = "↻ restarted with new knobs";
  setTimeout(() => {
    if (token !== runToken) return;
    $("stageMsg").className = "stagemsg"; $("stageMsg").textContent = "";
  }, 900);
}

let resimTimer = null;
function scheduleResim() {
  const bothHouse = houseBots[$("homeSel").value] && houseBots[$("awaySel").value];
  clearTimeout(resimTimer);
  resimTimer = setTimeout(resim, bothHouse ? 90 : 450); // instant in-browser vs rate-limited server
}

// changing either dropdown re-runs immediately
for (const sel of [$("homeSel"), $("awaySel")]) {
  sel.addEventListener("change", () => setMatchup($("homeSel").value, $("awaySel").value));
}
$("watchBtn").addEventListener("click", watch);
$("pp").addEventListener("click", () => player.toggle());
$("scrub").addEventListener("input", () => player.seek(Number($("scrub").value)));
$("speedSel").addEventListener("change", () => (player.speed = Number($("speedSel").value)));
player.speed = Number($("speedSel").value);

// 🎲 random seed -> new game, re-run
$("diceBtn").addEventListener("click", () => {
  $("seedInput").value = String(1 + Math.floor(Math.random() * 9999));
  watch();
});
$("seedInput").addEventListener("change", watch);

// fullscreen the whole theater (field + matchup + controls)
$("fsBtn").addEventListener("click", () => {
  const el = document.querySelector(".theater");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
});

// Modals: Play/Compete and How it works (native <dialog>)
$("playBtn").addEventListener("click", () => {
  $("competeModal").showModal();
  window.trackCompeteOpen && window.trackCompeteOpen(); // conversion event for ads
});
$("howBtn").addEventListener("click", () => $("howModal").showModal());
for (const dlg of document.querySelectorAll("dialog.modal")) {
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); }); // click backdrop to close
}
for (const b of document.querySelectorAll("[data-close]")) {
  b.addEventListener("click", () => b.closest("dialog")?.close());
}

// keyboard: space = play/pause, ← → = step a frame (ignored while typing)
document.addEventListener("keydown", (e) => {
  if (["INPUT", "SELECT", "TEXTAREA"].includes(e.target.tagName)) return;
  if (e.code === "Space") { e.preventDefault(); player.toggle(); }
  else if (e.code === "ArrowRight") { e.preventDefault(); player.seek(player.i + 1); }
  else if (e.code === "ArrowLeft") { e.preventDefault(); player.seek(player.i - 1); }
});

// Copy buttons next to each command block
for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", async () => {
    const code = btn.previousElementSibling;
    try {
      await navigator.clipboard.writeText(code.textContent.trim());
      const label = btn.textContent;
      btn.textContent = "Copied ✓";
      btn.classList.add("copied");
      setTimeout(() => { btn.textContent = label; btn.classList.remove("copied"); }, 1200);
    } catch {}
  });
}

// Name your bot -> validate, check availability, fill the name-dependent commands.
const SAFE_NAME = /^[a-z0-9_-]{2,24}$/i;
function updateBotName() {
  const raw = $("botName").value.trim();
  const name = raw || "your-bot-name";
  const tour = $("tourCode") ? $("tourCode").value.trim() : "";
  const tourFlag = tour ? ` --tournament ${tour}` : "";
  $("cmdSubmit").textContent = `npm run submit -- ${name}${tourFlag}`;
  $("cmdOneliner").textContent = `git clone https://github.com/amitayk/claude-ball && cd claude-ball && npm install && npm run new ${name} -- --here && cd ${name}`;
  $("cmdDesktop").textContent =
    `I want to build a bot for Claude Ball (a deterministic 4-a-side football AI competition). Set it up on my Desktop using your filesystem + terminal access:

1. Clone https://github.com/amitayk/claude-ball into a new folder on my Desktop.
2. cd into it and run \`npm install\`.
3. Scaffold my bot: \`npm run new ${name} -- --here\`, then cd into the \`${name}\` folder.
4. Tell me the full path and read CLAUDE.md - it keeps you to coding; the tactics are mine.

Then I'll describe my football tactics and you'll write the bot code in that folder. When I'm happy, run \`npm run submit -- ${name}${tourFlag}\` to put it on the ladder.`;
  const st = $("nameStatus");
  let ok = false;
  if (!raw) {
    st.textContent = ""; st.className = "namestatus";
  } else if (!SAFE_NAME.test(raw)) {
    st.textContent = "2-24: a-z 0-9 - _"; st.className = "namestatus bad";
  } else {
    const lower = raw.toLowerCase();
    const taken = bots.some((b) => {
      if ((b.name || "").toLowerCase() === lower) return true;
      return b.kind === "user" && (b.handle || "").toLowerCase() === lower;
    });
    st.textContent = taken ? "taken ✗" : "available ✓";
    st.className = "namestatus " + (taken ? "bad" : "ok");
    ok = !taken;
  }
  for (const b of document.querySelectorAll(".copy[data-name]")) b.disabled = !ok;
}
$("botName").addEventListener("input", updateBotName);
if ($("tourCode")) $("tourCode").addEventListener("input", updateBotName);
updateBotName();

// OS tabs: the only OS-specific command is the install one. Auto-detect.
const OS_INSTALL = {
  mac: "brew install git node",
  windows: "winget install Git.Git OpenJS.NodeJS",
  linux: "sudo apt install -y git nodejs npm",
};
function detectOS() {
  const p = (navigator.userAgentData?.platform || navigator.platform || navigator.userAgent || "").toLowerCase();
  if (p.includes("win")) return "windows";
  if (p.includes("mac") || p.includes("iphone") || p.includes("ipad")) return "mac";
  if (p.includes("linux") || p.includes("x11") || p.includes("android")) return "linux";
  return "mac";
}
function setOS(os) {
  for (const b of document.querySelectorAll("#osTabs button")) b.classList.toggle("active", b.dataset.os === os);
  $("cmdInstall").textContent = OS_INSTALL[os] ?? OS_INSTALL.mac;
}
for (const b of document.querySelectorAll("#osTabs button")) b.addEventListener("click", () => setOS(b.dataset.os));
setOS(detectOS());

// Tool selector: switch between the terminal (Claude Code) and Desktop-app paths.
function setMode(mode) {
  for (const b of document.querySelectorAll("#modeTabs button")) b.classList.toggle("active", b.dataset.mode === mode);
  for (const p of document.querySelectorAll(".modepanel")) p.hidden = p.dataset.panel !== mode;
}
for (const b of document.querySelectorAll("#modeTabs button")) b.addEventListener("click", () => setMode(b.dataset.mode));
setMode("cli");

// Gentle, directional snap: when scrolling settles near the field, ease it to the
// top — only in the direction you're already heading, so scrolling PAST it never
// yanks you back. (No width change — the card keeps a fixed size.)
const theaterEl = document.querySelector(".theater");
let lastY = window.scrollY, scrollDir = 0, snapTimer = null, snapping = false;
function maybeSnap() {
  if (snapping) return;
  const top = theaterEl.getBoundingClientRect().top;
  const BAND = 130;
  let should = false;
  if (scrollDir > 0 && top > 2 && top < BAND) should = true;
  else if (scrollDir < 0 && top < -2 && top > -BAND) should = true;
  if (!should) return;
  snapping = true;
  window.scrollBy({ top, behavior: "smooth" });
  setTimeout(() => { snapping = false; }, 500);
}
addEventListener("scroll", () => {
  const y = window.scrollY;
  if (y !== lastY) scrollDir = y > lastY ? 1 : -1;
  lastY = y;
  if (snapTimer) clearTimeout(snapTimer);
  snapTimer = setTimeout(maybeSnap, 140);
}, { passive: true });

refresh();
setInterval(refresh, 6000);
