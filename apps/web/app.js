import { MatchPlayer } from "./match.js";

// API base: ?api=<url> (persisted) > window.KR_API > saved > localhost. Lets the
// static web app be deployed once and pointed at any arena.
const qApi = new URLSearchParams(location.search).get("api");
if (qApi) localStorage.setItem("kr_api", qApi);
const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
// In production the API serves this page, so default to same-origin ("").
const API = window.KR_API ?? qApi ?? localStorage.getItem("kr_api") ?? (isLocal ? "http://localhost:8787" : "");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
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
    $("conn").textContent = "● live";
    $("conn").classList.add("ok");
    if (firstLoad && bots.length >= 2) {
      firstLoad = false;
      $("homeSel").value = bots[0].name;
      $("awaySel").value = bots[1].name;
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
      const pill = isUser ? `<span class="pill you">you</span>` : `<span class="pill lib">house</span>`;
      const wdl = b.record ? `${b.record.wins}-${b.record.draws}-${b.record.losses}` : "-";
      const fill = Math.round(((b.elo - min) / span) * 100);
      const blurb = b.blurb ? `<div class="blurb">${esc(b.blurb)}</div>` : "";
      return `<li class="row ${isUser ? "you" : ""}" data-name="${esc(b.name)}">
        <div class="rank ${i < 3 ? "m" + (i + 1) : ""}">${medal}</div>
        <div class="who"><div class="name">${esc(b.name)} ${pill}</div>
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
    sel.innerHTML = bots.map((b) => `<option value="${esc(b.name)}">${esc(b.name)} · ${b.elo}</option>`).join("");
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

async function watch() {
  const home = $("homeSel").value, away = $("awaySel").value, seed = $("seedInput").value || 1;
  if (!home || !away) return;
  $("theaterScore").textContent = "running…";
  try {
    const res = await fetch(`${API}/api/watch?home=${encodeURIComponent(home)}&away=${encodeURIComponent(away)}&seed=${seed}`);
    const data = await res.json();
    if (!res.ok) { $("theaterScore").textContent = data.error || "match failed"; return; }
    player.load(data.replay, { home: data.home.name, away: data.away.name });
  } catch {
    $("theaterScore").textContent = "couldn't run the match";
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

// fullscreen the pitch (B)
$("fsBtn").addEventListener("click", () => {
  const el = document.querySelector(".stagewrap");
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

// click a command to copy it
for (const el of document.querySelectorAll(".cmd")) {
  el.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(el.textContent.trim());
      el.classList.add("copied");
      setTimeout(() => el.classList.remove("copied"), 1200);
    } catch {}
  });
}

refresh();
setInterval(refresh, 6000);
