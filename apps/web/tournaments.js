const API = ["localhost", "127.0.0.1"].includes(location.hostname) ? "http://localhost:8787" : "";
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

async function load() {
  try {
    const r = await fetch(`${API}/api/tournaments`, { cache: "no-store" });
    const { tournaments } = await r.json();
    $("tlist").innerHTML = tournaments.length
      ? tournaments.map((t) => `
        <li><a href="/tournament.html?slug=${encodeURIComponent(t.slug)}">
          <div>
            <div style="font-weight:700">${esc(t.name)}</div>
            <div class="meta">${esc(t.org)} · ${t.bots} bot${t.bots === 1 ? "" : "s"}${t.champion ? ` · 🏆 ${esc(t.champion)}` : ""}</div>
          </div>
          <span class="badge ${t.status === "done" ? "done" : ""}">${t.status}</span>
        </a></li>`).join("")
      : `<li class="muted">No tournaments yet - create one above.</li>`;
  } catch {
    $("tlist").innerHTML = `<li class="muted">Couldn't reach the arena.</li>`;
  }
}

$("createBtn").addEventListener("click", async () => {
  const org = $("org").value.trim(), name = $("tname").value.trim();
  if (!org || !name) {
    $("created").innerHTML = `<p class="small" style="color:#ff6b6b;margin-top:10px">Enter both an org and a tournament name.</p>`;
    return;
  }
  $("createBtn").disabled = true;
  try {
    const r = await fetch(`${API}/api/tournaments`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ org, name }) });
    const d = await r.json();
    if (!r.ok) { $("created").innerHTML = `<p class="small" style="color:#ff6b6b;margin-top:10px">${esc(d.error || "failed")}</p>`; return; }
    const slug = d.tournament.slug;
    $("created").innerHTML = `
      <div class="slugbox">
        <div class="small muted">Your tournament code - players paste it into <b>Compete → tournament code</b> (or append <code>--tournament ${esc(slug)}</code> when they submit):</div>
        <div class="cmdrow" style="margin-top:8px"><code class="cmd">${esc(slug)}</code><button class="copy" data-copy="${esc(slug)}">Copy</button></div>
        <a class="primary" style="display:inline-block;margin-top:12px;text-decoration:none" href="/tournament.html?slug=${encodeURIComponent(slug)}">Open tournament →</a>
      </div>`;
    $("org").value = ""; $("tname").value = "";
    bindCopy();
    load();
  } finally {
    $("createBtn").disabled = false;
  }
});

function bindCopy() {
  for (const b of document.querySelectorAll(".copy[data-copy]")) {
    b.onclick = async () => {
      try { await navigator.clipboard.writeText(b.dataset.copy); const t = b.textContent; b.textContent = "Copied ✓"; setTimeout(() => (b.textContent = t), 1200); } catch {}
    };
  }
}

load();
