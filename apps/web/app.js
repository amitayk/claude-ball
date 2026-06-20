// Arena web app — fetches the leaderboard and renders it. No build step.
const API = window.KR_API || localStorage.getItem("kr_api") || "http://localhost:8787";
document.getElementById("apihint").textContent = API;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const MEDAL = ["🥇", "🥈", "🥉"];

async function refresh() {
  try {
    const res = await fetch(`${API}/api/leaderboard`, { cache: "no-store" });
    const data = await res.json();
    render(data.bots || []);
    $("conn").textContent = "● live";
    $("conn").classList.add("ok");
  } catch {
    $("conn").textContent = "○ can't reach the arena — is it running?";
    $("conn").classList.remove("ok");
  }
}

function render(bots) {
  $("count").textContent = `${bots.length} bots`;
  const maxElo = Math.max(1, ...bots.map((b) => b.elo));
  const minElo = Math.min(...bots.map((b) => b.elo));
  const span = Math.max(1, maxElo - minElo);

  $("rows").innerHTML = bots
    .map((b, i) => {
      const isUser = b.kind === "user";
      const medal = i < 3 ? MEDAL[i] : i + 1;
      const rankClass = i < 3 ? `rank m${i + 1}` : "rank";
      const owner = isUser ? `@${esc(b.handle)}` : "house";
      const pill = isUser ? `<span class="pill you">you</span>` : `<span class="pill lib">house</span>`;
      const wdl = b.record ? `${b.record.wins}-${b.record.draws}-${b.record.losses}` : "—";
      const fill = Math.round(((b.elo - minElo) / span) * 100);
      const blurb = b.blurb ? `<div class="blurb">${esc(b.blurb)}</div>` : "";
      return `
        <li class="row ${isUser ? "you" : ""}">
          <div class="${rankClass}">${medal}</div>
          <div class="who">
            <div class="name">${esc(b.name)} ${pill}</div>
            <div class="owner">${owner} · <span class="wdl">${wdl}</span></div>
            ${blurb}
          </div>
          <div class="stat">
            <div class="elo">${b.elo}</div>
            <div class="elobar"><span style="width:${fill}%"></span></div>
          </div>
        </li>`;
    })
    .join("");
}

refresh();
setInterval(refresh, 4000);
