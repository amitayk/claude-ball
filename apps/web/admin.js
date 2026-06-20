const isLocal = ["localhost", "127.0.0.1"].includes(location.hostname);
const API = window.KR_API ?? (isLocal ? "http://localhost:8787" : "");
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

$("token").value = localStorage.getItem("kr_admin") || "";

async function load() {
  localStorage.setItem("kr_admin", $("token").value);
  const res = await fetch(`${API}/api/leaderboard`, { cache: "no-store" });
  const bots = (await res.json()).bots || [];
  $("rows").innerHTML = bots
    .map(
      (b) => `<li class="row" data-id="${esc(b.id)}">
        <div class="who"><div class="name">${esc(b.name)} <span class="pill ${b.kind === "user" ? "you" : "lib"}">${b.kind}</span></div>
          <div class="owner">${b.kind === "user" ? "@" + esc(b.handle) : "house"} · Elo ${b.elo} · ${esc(b.id)}</div></div>
        <div class="stat">${b.kind === "user" ? `<button class="del" data-id="${esc(b.id)}">Delete</button>` : '<span class="muted small">protected</span>'}</div>
      </li>`,
    )
    .join("");
  for (const btn of document.querySelectorAll(".del")) {
    btn.addEventListener("click", () => del(btn.dataset.id));
  }
}

async function del(id) {
  if (!confirm(`Delete bot ${id}?`)) return;
  const res = await fetch(`${API}/api/admin/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id, token: $("token").value }),
  });
  if (res.ok) load();
  else alert((await res.json()).error || "failed");
}

$("reload").addEventListener("click", load);
if ($("token").value) load();
