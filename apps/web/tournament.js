import { MatchPlayer } from "./match.js";

const API = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8787" : "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const slug = new URLSearchParams(location.search).get("slug") || "";
let player = null;

async function load() {
  let data;
  try {
    const r = await fetch(`${API}/api/tournament?slug=${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (!r.ok) throw new Error();
    data = await r.json();
  } catch {
    document.querySelector(".wrap").innerHTML = `<p class="muted" style="padding:40px 0">Tournament not found. <a href="/tournaments.html" style="color:var(--accent)">All tournaments →</a></p>`;
    return;
  }
  const { tournament: t, bots } = data;
  document.title = `${t.name} · claude-ball`;
  $("thead").textContent = `⚽ ${t.name}`;
  $("slugtext").textContent = t.slug;
  $("joincmd").textContent = `npm run submit -- your-bot-name --tournament ${t.slug}`;
  $("entrantsTitle").textContent = `Entrants (${bots.length})`;
  const ranked = [...bots].sort((a, b) => b.elo - a.elo);
  $("entrants").innerHTML = ranked.length
    ? ranked.map((b, i) => `<li><div class="ent"><div><b>${i + 1}. ${esc(cap(b.name))}</b> <span class="meta">@${esc(b.handle)}</span></div><span class="meta">strength ${b.elo}</span></div></li>`).join("")
    : `<li class="muted">No bots yet - share the code above to fill the bracket.</li>`;
  $("runBtn").disabled = bots.length < 2;
  $("runBtn").textContent = t.status === "done" ? "↻ Re-run playoff" : "▶ Start playoff";
  if (t.result) renderBracket(t.result);
}

$("runBtn").addEventListener("click", async () => {
  $("runBtn").disabled = true;
  $("runMsg").className = "stagemsg loading"; $("runMsg").textContent = "running the playoff - playing sandboxed matches…";
  try {
    const r = await fetch(`${API}/api/tournament/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    const d = await r.json();
    if (!r.ok) { $("runMsg").className = "stagemsg err"; $("runMsg").textContent = d.error || "failed"; return; }
    $("runMsg").className = "stagemsg"; $("runMsg").textContent = "";
    renderBracket(d.tournament.result);
    $("runBtn").textContent = "↻ Re-run playoff";
  } catch {
    $("runMsg").className = "stagemsg err"; $("runMsg").textContent = "couldn't run the playoff";
  } finally {
    $("runBtn").disabled = false;
  }
});

function renderBracket(result) {
  $("bracketCard").style.display = "";
  $("champ").innerHTML = `<div class="champ">🏆 Champion: <b>${esc(cap(result.champion.name))}</b> <span class="meta">@${esc(result.champion.handle)}</span></div>`;
  const n = result.rounds.length;
  const roundName = (i) => (i === n - 1 ? "Final" : i === n - 2 ? "Semifinals" : i === n - 3 ? "Quarterfinals" : `Round ${i + 1}`);
  $("bracket").innerHTML = result.rounds
    .map((rnd, ri) => `<div class="round"><div class="roundname">${roundName(ri)}</div>${rnd.map(matchCard).join("")}</div>`)
    .join("");
  for (const el of document.querySelectorAll(".match[data-a]")) {
    el.addEventListener("click", () => watch(el.dataset.a, el.dataset.b, Number(el.dataset.seed), el.dataset.label));
  }
}

function matchCard(m) {
  if (m.bye) {
    const w = m.winner;
    return `<div class="match bye"><div class="slot win"><span>${esc(cap(w.name))}</span><b></b></div><div class="slot"><span>bye</span><b></b></div></div>`;
  }
  const aw = m.winner && m.a && m.winner.id === m.a.id;
  const bw = m.winner && m.b && m.winner.id === m.b.id;
  return `<div class="match" data-a="${esc(m.a.id)}" data-b="${esc(m.b.id)}" data-seed="${m.seed}" data-label="${esc(cap(m.a.name))} vs ${esc(cap(m.b.name))}" title="click to watch">
    <div class="slot ${aw ? "win" : ""}"><span>${esc(cap(m.a.name))}</span><b>${m.score ? m.score.a : ""}</b></div>
    <div class="slot ${bw ? "win" : ""}"><span>${esc(cap(m.b.name))}</span><b>${m.score ? m.score.b : ""}</b></div>
  </div>`;
}

async function watch(a, b, seed, label) {
  $("watchCard").style.display = "";
  $("watchTitle").textContent = `▶ ${label}  (running…)`;
  if (!player) {
    player = new MatchPlayer($("pitch"));
    player.onTick = (i, nn) => {
      $("scrub").max = String(Math.max(0, nn - 1));
      $("scrub").value = String(i);
      if (player.replay) $("ttime").textContent = (player.replay.frames[i].t * player.meta.dt).toFixed(1) + "s";
      $("pp").textContent = player.playing ? "⏸" : "▶";
    };
  }
  try {
    const r = await fetch(`${API}/api/watch?home=${encodeURIComponent(a)}&away=${encodeURIComponent(b)}&seed=${seed}`);
    const d = await r.json();
    if (!r.ok) { $("watchTitle").textContent = d.error || "match failed"; return; }
    player.load(d.replay, { home: cap(d.home.name), away: cap(d.away.name) });
    $("watchTitle").textContent = `▶ ${label}`;
    $("watchCard").scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    $("watchTitle").textContent = "couldn't load the match";
  }
}

$("pp").addEventListener("click", () => player?.toggle());
$("scrub").addEventListener("input", () => player?.seek(Number($("scrub").value)));
$("joincopy").addEventListener("click", async () => {
  try { await navigator.clipboard.writeText($("joincmd").textContent); const t = $("joincopy").textContent; $("joincopy").textContent = "Copied ✓"; setTimeout(() => ($("joincopy").textContent = t), 1200); } catch {}
});

load();
