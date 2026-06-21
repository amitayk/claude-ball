import { MatchPlayer } from "./match.js";
import { BRAND, REPO } from "./brand.js";

// Brand the page from one const.
document.title = `${BRAND} · the arena`;
{
  const logo = document.querySelector(".logo");
  if (logo) logo.textContent = `⚽ ${BRAND}`;
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
  if (player.replay) {
    const f = player.replay.frames[i];
    $("ttime").textContent = (f.t * player.meta.dt).toFixed(1) + "s";
    $("theaterScore").innerHTML =
      `<b class="cH">${esc(player.names.home)}</b> ${f.score.home} - ${f.score.away} <b class="cA">${esc(player.names.away)}</b>`;
  }
  $("pp").textContent = player.playing ? "⏸" : "▶";
};

let bots = [];
let firstLoad = true;

async function refresh() {
  try {
    const res = await fetch(`${API}/api/leaderboard`, { cache: "no-store" });
    bots = (await res.json()).bots || [];
    renderBoard();
    syncSelects();
    updateBotName();
    $("conn").textContent = "● live";
    $("conn").classList.add("ok");
    if (firstLoad && bots.length >= 1) {
      firstLoad = false;
      const has = (n) => !!n && bots.some((b) => b.name === n);
      let home, away;
      if (has(initHome)) {
        // shared/submit link: a specific bot, defaulting its opponent to blitz
        home = initHome;
        away = has(initAway) ? initAway : home === "blitz" ? "formation" : "blitz";
      } else {
        home = has("blitz") ? "blitz" : bots[0].name;
        away = has("formation") ? "formation" : bots.find((b) => b.name !== home)?.name ?? home;
      }
      if (!has(away) || away === home) away = bots.find((b) => b.name !== home)?.name ?? home;
      $("homeSel").value = home;
      $("awaySel").value = away;
      if (initSeed && /^\d+$/.test(initSeed)) $("seedInput").value = initSeed;
      watch();
    }
  } catch {
    $("conn").textContent = "○ can't reach the arena - run `npm run api`";
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
      return `<li class="row ${isUser ? "you" : ""}" data-name="${esc(b.name)}">
        <div class="rank ${i < 3 ? "m" + (i + 1) : ""}">${medal}</div>
        <div class="who"><div class="name">${esc(cap(b.name))} ${pill}</div>
          <div class="owner">${isUser ? "@" + esc(b.handle) : "house"} · <span class="wdl">${wdl}</span></div>${blurb}</div>
        <div class="stat"><div class="elo">${b.elo}</div><div class="elobar"><span style="width:${fill}%"></span></div></div>
      </li>`;
    })
    .join("");
  for (const li of document.querySelectorAll(".row")) {
    li.addEventListener("click", () => pickMatchup(li.dataset.name));
  }
}

function syncSelects() {
  for (const sel of [$("homeSel"), $("awaySel")]) {
    const keep = sel.value;
    sel.innerHTML = bots.map((b) => `<option value="${esc(b.name)}">${esc(cap(b.name))} · ${b.elo}</option>`).join("");
    if (bots.some((b) => b.name === keep)) sel.value = keep;
  }
}

function pickMatchup(name) {
  $("homeSel").value = name;
  if ($("awaySel").value === name) {
    const other = bots.find((b) => b.name !== name);
    if (other) $("awaySel").value = other.name;
  }
  watch();
  document.querySelector(".theater").scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateUrl(home, away, seed) {
  const p = new URLSearchParams(location.search);
  p.set("home", home);
  p.set("away", away);
  p.set("seed", String(seed));
  history.replaceState(null, "", `${location.pathname}?${p.toString()}`);
}

async function watch() {
  const home = $("homeSel").value, away = $("awaySel").value, seed = $("seedInput").value || 1;
  if (!home || !away) return;
  updateUrl(home, away, seed);
  const btn = $("watchBtn");
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = "Running…";
  $("theaterScore").innerHTML = `<span class="loading">running match…</span>`;
  try {
    const res = await fetch(`${API}/api/watch?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&seed=${seed}`);
    const data = await res.json();
    if (!res.ok) { $("theaterScore").textContent = data.error || "match failed"; return; }
    player.load(data.replay, { home: cap(data.home.name), away: cap(data.away.name) });
  } catch {
    $("theaterScore").textContent = "couldn't run the match";
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

$("watchBtn").addEventListener("click", watch);
$("pp").addEventListener("click", () => player.toggle());
$("scrub").addEventListener("input", () => player.seek(Number($("scrub").value)));
$("speedSel").addEventListener("change", () => (player.speed = Number($("speedSel").value)));
player.speed = Number($("speedSel").value); // default 1.5×

// 🎲 random seed → re-run
$("diceBtn").addEventListener("click", () => {
  $("seedInput").value = String(1 + Math.floor(Math.random() * 9999));
  watch();
});

// fullscreen the whole theater (field + matchup + score + controls)
$("fsBtn").addEventListener("click", () => {
  const el = document.querySelector(".theater");
  if (document.fullscreenElement) document.exitFullscreen();
  else el.requestFullscreen?.();
});

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

// Step 2: pick a bot name -> validate, check availability, fill the commands.
const SAFE_NAME = /^[a-z0-9_-]{2,24}$/i;
function updateBotName() {
  const raw = $("botName").value.trim();
  const name = raw || "your-bot-name";
  $("cmdNew").textContent = `npm run new ${name} && cd ${name}`;
  $("cmdSubmit").textContent = `KR_HANDLE=${name} npm run submit`;
  const st = $("nameStatus");
  if (!raw) { st.textContent = ""; st.className = "namestatus"; return; }
  if (!SAFE_NAME.test(raw)) { st.textContent = "2-24: a-z 0-9 - _"; st.className = "namestatus bad"; return; }
  const lower = raw.toLowerCase();
  const taken = bots.some((b) => {
    if ((b.name || "").toLowerCase() === lower) return true; // any bot's name (incl. house)
    return b.kind === "user" && (b.handle || "").toLowerCase() === lower; // a taken handle
  });
  st.textContent = taken ? "taken ✗" : "available ✓";
  st.className = "namestatus " + (taken ? "bad" : "ok");
}
$("botName").addEventListener("input", updateBotName);

// Widen the field card from a centred card toward full width as it snaps to the
// top of the viewport (full width = fully snapped).
const theaterEl = document.querySelector(".theater");
const NARROW = 1080;
let snapTick = false;
function applySnapWidth() {
  snapTick = false;
  const top = Math.max(0, theaterEl.getBoundingClientRect().top);
  const start = window.innerHeight * 0.55; // begin widening within this distance of the top
  const p = Math.max(0, Math.min(1, 1 - top / start));
  const full = document.documentElement.clientWidth;
  theaterEl.style.maxWidth = Math.round(NARROW + Math.max(0, full - NARROW) * p) + "px";
  theaterEl.style.borderRadius = (14 * (1 - p)).toFixed(1) + "px";
}
addEventListener("scroll", () => { if (!snapTick) { snapTick = true; requestAnimationFrame(applySnapWidth); } }, { passive: true });
addEventListener("resize", applySnapWidth);
applySnapWidth();

// Gentle, directional snap: when scrolling settles near the field, ease it to the
// top — but only in the direction you're already heading, so scrolling PAST it
// never yanks you back.
let lastY = window.scrollY, scrollDir = 0, snapTimer = null, snapping = false;
function maybeSnap() {
  if (snapping) return;
  const top = theaterEl.getBoundingClientRect().top;
  const BAND = 130;
  let should = false;
  if (scrollDir > 0 && top > 2 && top < BAND) should = true;        // arriving from above
  else if (scrollDir < 0 && top < -2 && top > -BAND) should = true; // returning from below
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
