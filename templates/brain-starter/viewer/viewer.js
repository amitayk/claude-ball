// Plain browser JS — no build step. Loads replay.json and animates it.
const canvas = document.getElementById("pitch");
const ctx = canvas.getContext("2d");
const scoreEl = document.getElementById("score");
const scrub = document.getElementById("scrub");
const timeEl = document.getElementById("time");
const playBtn = document.getElementById("playpause");
const speedSel = document.getElementById("speed");

const COLORS = { home: "#4f9dff", away: "#ff7a59", ball: "#ffffff", line: "rgba(255,255,255,0.25)" };

let replay = null;
let frameIdx = 0;
let playing = true;
let acc = 0;
let last = performance.now();

async function load() {
  const res = await fetch("./replay.json");
  if (!res.ok) {
    scoreEl.textContent = "no replay.json — run: npm run demo";
    return;
  }
  replay = await res.json();
  canvas.width = replay.meta.field.width;
  canvas.height = replay.meta.field.height;
  scrub.max = String(replay.frames.length - 1);
  requestAnimationFrame(loop);
}

function drawPitch(field) {
  const { width, height, goalHeight } = field;
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = "#15602f";
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = COLORS.line;
  ctx.lineWidth = 2;
  ctx.strokeRect(8, 8, width - 16, height - 16);
  ctx.beginPath();
  ctx.moveTo(width / 2, 8);
  ctx.lineTo(width / 2, height - 8);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(width / 2, height / 2, 70, 0, Math.PI * 2);
  ctx.stroke();

  // Goal mouths
  const top = (height - goalHeight) / 2;
  ctx.strokeStyle = "rgba(255,255,255,0.8)";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(4, top); ctx.lineTo(4, top + goalHeight);
  ctx.moveTo(width - 4, top); ctx.lineTo(width - 4, top + goalHeight);
  ctx.stroke();
}

function drawFrame(f) {
  drawPitch(replay.meta.field);
  for (const p of f.players) {
    ctx.beginPath();
    ctx.fillStyle = COLORS[p.side];
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    if (p.ball) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = "#fff";
      ctx.stroke();
    }
  }
  ctx.beginPath();
  ctx.fillStyle = COLORS.ball;
  ctx.arc(f.ball.x, f.ball.y, 8, 0, Math.PI * 2);
  ctx.fill();

  scoreEl.innerHTML =
    `<span class="home">${replay.meta.teams.home} ${f.score.home}</span>` +
    ` &nbsp;–&nbsp; ` +
    `<span class="away">${f.score.away} ${replay.meta.teams.away}</span>`;
  timeEl.textContent = (f.t * replay.meta.dt).toFixed(1) + "s";
  scrub.value = String(frameIdx);
}

function loop(now) {
  const dtReal = (now - last) / 1000;
  last = now;
  if (playing && replay) {
    acc += dtReal * Number(speedSel.value);
    const step = replay.meta.dt;
    while (acc >= step) {
      acc -= step;
      frameIdx = Math.min(frameIdx + 1, replay.frames.length - 1);
      if (frameIdx >= replay.frames.length - 1) playing = false;
    }
  }
  if (replay) drawFrame(replay.frames[frameIdx]);
  requestAnimationFrame(loop);
}

playBtn.addEventListener("click", () => {
  if (frameIdx >= replay.frames.length - 1) frameIdx = 0;
  playing = !playing;
  playBtn.textContent = playing ? "⏸ pause" : "▶ play";
});
scrub.addEventListener("input", () => {
  frameIdx = Number(scrub.value);
  playing = false;
  playBtn.textContent = "▶ play";
});

load();
