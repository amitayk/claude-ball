import { MatchPlayer } from "./match.js";
import { BRAND, REPO } from "./brand.js";

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
  history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
}

async function watch() {
  const home = $("homeSel").value, away = $("awaySel").value, seed = $("seedInput").value || 1;
  if (!home || !away) return;
  updateUrl(home, away, seed);
  const btn = $("watchBtn");
  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = "Running…";
  $("stageMsg").className = "stagemsg loading";
  $("stageMsg").textContent = "running match…";
  try {
    const res = await fetch(`${API}/api/watch?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&seed=${seed}`);
    const data = await res.json();
    if (!res.ok) { $("stageMsg").className = "stagemsg err"; $("stageMsg").textContent = data.error || "match failed"; return; }
    player.load(data.replay, { home: cap(data.home.name), away: cap(data.away.name) });
    $("stageMsg").className = "stagemsg"; $("stageMsg").textContent = "";
  } catch {
    $("stageMsg").className = "stagemsg err"; $("stageMsg").textContent = "couldn't run the match";
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
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
  $("cmdSubmit").textContent = `npm run submit -- ${name}`;
  $("cmdOneliner").textContent = `git clone https://github.com/amitayk/claude-ball && cd claude-ball && npm install && npm run new ${name} -- --here && cd ${name}`;
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
