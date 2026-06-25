import { MatchPlayer } from "./match.js";

const API = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8787" : "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const gc = (path, title) => { try { window.goatcounter && window.goatcounter.count({ path, title, event: true }); } catch (e) {} };
const slug = new URLSearchParams(location.search).get("slug") || "";

let player = null;
let tourMeta = null;          // { org, name, slug } for building the invite message
let result = null;            // current league result { games, standings, champion }
let refs = new Map();         // id -> { name, handle }
let games = [];
let played = 0;               // games revealed so far
let playing = false, done = false, speed = 1;
let t1 = null, t2 = null;

// ── load ──────────────────────────────────────────────────────────────────────
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
  tourMeta = { org: t.org, name: t.name, slug: t.slug };
  document.title = `${t.name} · claude-ball`;
  $("thead").textContent = `⚽ ${t.name}`;
  $("slugtext").textContent = t.slug;
  $("joincmd").textContent = `npm run submit -- your-bot-name --tournament ${t.slug}`;
  $("entrantsTitle").textContent = `Entrants (${bots.length})`;
  const ranked = [...bots].sort((a, b) => b.elo - a.elo);
  $("entrants").innerHTML = ranked.length
    ? ranked.map((b, i) => `<li><div class="ent"><div><b>${i + 1}. ${esc(cap(b.name))}</b> <span class="meta">@${esc(b.handle)}</span></div><span class="meta">strength ${b.elo}</span></div></li>`).join("")
    : `<li class="muted">No bots yet - share the code above to fill the league.</li>`;
  $("runBtn").disabled = bots.length < 2;
  $("runBtn").textContent = t.status === "done" ? "↻ Re-run league" : "▶ Kick off the league";

  if (t.slackConnected) { $("slackForm").style.display = "none"; $("slackOn").style.display = ""; }
  if (t.result) { result = t.result; finalize(false); } // show finished table + podium, ready to replay
}

$("runBtn").addEventListener("click", async () => {
  $("runBtn").disabled = true;
  $("runMsg").className = "stagemsg loading";
  $("runMsg").textContent = "playing the league - running sandboxed matches…";
  try {
    const r = await fetch(`${API}/api/tournament/run`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    const d = await r.json();
    if (!r.ok) { $("runMsg").className = "stagemsg err"; $("runMsg").textContent = d.error || "failed"; return; }
    $("runMsg").className = "stagemsg"; $("runMsg").textContent = "";
    result = d.tournament.result;
    gc("league-run", "League run"); // B2B-intent funnel signal
    $("runBtn").textContent = "↻ Re-run league";
    startCinematic();
  } catch {
    $("runMsg").className = "stagemsg err"; $("runMsg").textContent = "couldn't run the league";
  } finally {
    $("runBtn").disabled = false;
  }
});

// ── standings (computed live from the games revealed so far) ────────────────────
function indexRefs() {
  refs = new Map(result.standings.map((s) => [s.id, { name: s.name, handle: s.handle }]));
  games = result.games;
}
function computeStandings(upTo) {
  const t = new Map([...refs].map(([id, r]) => [id, { id, name: r.name, handle: r.handle, played: 0, w: 0, d: 0, l: 0, gf: 0, ga: 0, gd: 0, pts: 0 }]));
  for (let i = 0; i < upTo; i++) {
    const g = games[i], A = t.get(g.a.id), B = t.get(g.b.id);
    A.played++; B.played++;
    A.gf += g.score.a; A.ga += g.score.b; B.gf += g.score.b; B.ga += g.score.a;
    if (!g.winner) { A.d++; B.d++; A.pts++; B.pts++; }
    else if (g.winner.id === g.a.id) { A.w++; B.l++; A.pts += 3; }
    else { B.w++; A.l++; B.pts += 3; }
  }
  for (const s of t.values()) s.gd = s.gf - s.ga;
  return [...t.values()].sort((x, y) => y.pts - x.pts || y.gd - x.gd || y.gf - x.gf || x.name.localeCompare(y.name));
}
function renderStandings(bump = []) {
  const tb = $("standings");
  const prev = new Map();
  for (const tr of tb.children) prev.set(tr.dataset.id, tr.getBoundingClientRect().top);
  const rows = computeStandings(played);
  tb.innerHTML = rows.map((s, i) => `
    <tr class="p${i + 1}${bump.includes(s.id) ? " bump" : ""}" data-id="${esc(s.id)}">
      <td class="l"><span class="rankdot">${i + 1}</span> ${esc(cap(s.name))}</td>
      <td>${s.played}</td><td>${s.w}</td><td>${s.d}</td><td>${s.l}</td><td>${s.gd > 0 ? "+" : ""}${s.gd}</td><td class="pts">${s.pts}</td>
    </tr>`).join("");
  for (const tr of tb.children) { // FLIP: animate rows from their old position
    const old = prev.get(tr.dataset.id);
    if (old == null) continue;
    const delta = old - tr.getBoundingClientRect().top;
    if (delta) { tr.style.transform = `translateY(${delta}px)`; tr.style.transition = "none"; requestAnimationFrame(() => { tr.style.transition = "transform .5s cubic-bezier(.2,.8,.2,1)"; tr.style.transform = ""; }); }
  }
  $("progFill").style.width = `${Math.round((played / games.length) * 100)}%`;
}

// ── fixture (the on-screen game) ────────────────────────────────────────────────
function renderFixture(g, pos, revealed) {
  const aw = revealed && g.winner && g.winner.id === g.a.id;
  const bw = revealed && g.winner && g.winner.id === g.b.id;
  $("md").textContent = `Matchday ${g.round + 1}  ·  Game ${pos + 1} of ${games.length}`;
  const team = (s, side, color, win, lose, score) => `
    <div class="team ${side} ${win ? "win" : lose ? "lose" : ""}">
      <div class="tname" style="color:${color}">${esc(cap(s.name))}</div><div class="thandle">@${esc(s.handle)}</div>
      <div class="tscore ${revealed ? "pop" : ""}">${revealed ? score : "–"}</div>
    </div>`;
  $("fixture").innerHTML =
    team(g.a, "A", "var(--home)", aw, revealed && !aw, g.score.a) +
    `<div class="vsbox">${revealed ? '<div class="vs">FT</div>' : '<div class="ball"></div><div class="vs">vs</div>'}</div>` +
    team(g.b, "B", "var(--away)", bw, revealed && !bw, g.score.b);
  $("fxresult").innerHTML = revealed ? (g.winner ? `<span class="winchip">✓ ${esc(cap(g.winner.name))} wins</span>` : "honours even - a draw") : "";
  if (revealed) {
    $("fxwatch").innerHTML = `<a>▶ watch this match</a>`;
    $("fxwatch").querySelector("a").onclick = () => watch(g.a.id, g.b.id, g.seed, `${cap(g.a.name)} vs ${cap(g.b.name)}`);
  } else $("fxwatch").innerHTML = "";
}

// ── cinematic playback ──────────────────────────────────────────────────────────
function startCinematic() {
  indexRefs();
  $("leagueCard").style.display = "";
  $("podiumCard").style.display = "none";
  played = 0; done = false; playing = true;
  $("ppBtn").disabled = false; $("ppBtn").textContent = "⏸";
  renderStandings();
  step();
  $("leagueCard").scrollIntoView({ behavior: "smooth", block: "start" });
}
function step() {
  clearTimeout(t1); clearTimeout(t2);
  if (played >= games.length) return finalize(true);
  const g = games[played];
  renderFixture(g, played, false);
  t1 = setTimeout(() => {
    renderFixture(g, played, true);
    played++;
    renderStandings([g.a.id, g.b.id]);
    t2 = setTimeout(() => { if (playing) step(); }, 1050 / speed);
  }, 800 / speed);
}
function setPlaying(p) {
  playing = p;
  $("ppBtn").textContent = p ? "⏸" : "▶";
  if (p) step(); else { clearTimeout(t1); clearTimeout(t2); }
}
$("ppBtn").addEventListener("click", () => { if (done) startCinematic(); else setPlaying(!playing); });
$("skipBtn").addEventListener("click", () => { clearTimeout(t1); clearTimeout(t2); playing = false; played = games.length; renderStandings(); finalize(true); });
$("spd").addEventListener("change", () => (speed = Number($("spd").value)));

// ── full time: standings + podium + all results ─────────────────────────────────
function finalize(cinematic) {
  indexRefs();
  played = games.length;
  done = true; playing = false;
  $("leagueCard").style.display = "";
  $("ppBtn").textContent = "▶"; $("ppBtn").title = "Replay the night";
  $("md").textContent = "🏁 Full time";
  renderStandings();

  const st = result.standings;
  $("podiumHead").textContent = `🏆 ${cap(st[0].name)} wins the league!`;
  const order = [st[1], st[0], st[2]].filter(Boolean); // 2nd, 1st, 3rd visual order
  $("podium").innerHTML = order.map((s) => {
    const place = st.indexOf(s) + 1, medal = ["🥇", "🥈", "🥉"][place - 1];
    return `<div class="pcol p${place}"><div class="medal">${medal}</div><div class="pname">${esc(cap(s.name))}</div>
      <div class="pcard"><div class="ppts">${s.pts} pts</div><div class="ppts">${s.w}-${s.d}-${s.l}</div></div></div>`;
  }).join("");
  $("allresults").innerHTML = games.map((g) => `
    <li data-a="${esc(g.a.id)}" data-b="${esc(g.b.id)}" data-seed="${g.seed}" data-label="${esc(cap(g.a.name))} vs ${esc(cap(g.b.name))}">
      <span>${esc(cap(g.a.name))} <b>${g.score.a}–${g.score.b}</b> ${esc(cap(g.b.name))}</span><span class="meta">MD${g.round + 1}</span></li>`).join("");
  for (const li of $("allresults").children) li.onclick = () => watch(li.dataset.a, li.dataset.b, Number(li.dataset.seed), li.dataset.label);
  $("podiumCard").style.display = "";
  if (cinematic) $("podiumCard").scrollIntoView({ behavior: "smooth", block: "center" });
}

// ── watch a single match's real replay ──────────────────────────────────────────
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

// ── invite your team (zero-setup, channel-agnostic) ─────────────────────────────
const inviteMessage = () =>
  `⚽ ${tourMeta.org} is running a claude-ball league: ${tourMeta.name}\n` +
  `Join: build a soccer bot in plain English (your AI writes the code), then submit it with the code "${tourMeta.slug}".\n` +
  `Watch live standings & every match here: ${location.href}`;
const copyText = async (text) => { try { await navigator.clipboard.writeText(text); return true; } catch { return false; } };
$("copyInvite").addEventListener("click", async () => {
  if (!tourMeta) return;
  const ok = await copyText(inviteMessage());
  $("inviteMsg").className = ok ? "stagemsg" : "stagemsg err";
  $("inviteMsg").textContent = ok ? "✓ invite copied — paste it in your team's chat" : "couldn't copy";
  if (ok) gc("team-invite-copied", "Team invite copied");
  setTimeout(() => { $("inviteMsg").textContent = ""; }, 2600);
});
$("copyLink").addEventListener("click", async () => {
  const ok = await copyText(location.href);
  const b = $("copyLink"), label = b.textContent;
  b.textContent = ok ? "Copied ✓" : "failed"; setTimeout(() => (b.textContent = label), 1200);
  if (ok) gc("team-link-copied", "Team link copied");
});

// ── Slack auto-post (optional, advanced) ────────────────────────────────────────
$("slackConnect").addEventListener("click", async () => {
  const webhook = $("slackUrl").value.trim();
  if (!webhook) { $("slackMsg").className = "stagemsg err"; $("slackMsg").textContent = "paste a webhook URL first"; return; }
  $("slackConnect").disabled = true; $("slackMsg").className = "stagemsg loading"; $("slackMsg").textContent = "connecting…";
  try {
    const r = await fetch(`${API}/api/tournament/slack`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug, webhook }) });
    const d = await r.json();
    if (!r.ok) { $("slackMsg").className = "stagemsg err"; $("slackMsg").textContent = d.error || "failed"; return; }
    $("slackMsg").className = "stagemsg"; $("slackMsg").textContent = "";
    $("slackForm").style.display = "none"; $("slackOn").style.display = "";
    gc("slack-connected", "Slack connected");
  } catch { $("slackMsg").className = "stagemsg err"; $("slackMsg").textContent = "couldn't connect"; }
  finally { $("slackConnect").disabled = false; }
});
$("slackInvite").addEventListener("click", async () => {
  $("slackInvite").disabled = true;
  try {
    const r = await fetch(`${API}/api/tournament/invite`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ slug }) });
    const d = await r.json();
    $("slackMsg").className = r.ok ? "stagemsg" : "stagemsg err";
    $("slackMsg").textContent = r.ok ? "✓ invite posted to your Slack channel" : (d.error || "failed");
    if (r.ok) gc("slack-invite", "Slack invite posted");
    setTimeout(() => { $("slackMsg").textContent = ""; }, 2500);
  } catch { $("slackMsg").className = "stagemsg err"; $("slackMsg").textContent = "couldn't post"; }
  finally { $("slackInvite").disabled = false; }
});

load();
