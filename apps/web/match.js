// Standalone replay player for the arena web app. Renders a MatchResult onto a
// canvas with playback + the same juice as the coach viewer (ball modes, halos,
// kickoff, direction labels). One instance drives one canvas.
const COLORS = { home: "#4f9dff", away: "#ff7a59", ball: "#fff", line: "rgba(255,255,255,0.22)" };
const PLAYER_R = 12;

export class MatchPlayer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d");
    this.replay = null;
    this.meta = null;
    this.names = { home: "home", away: "away" };
    this.youSide = null;
    this.i = 0;
    this.playing = false;
    this.speed = 2;
    this.acc = 0;
    this.last = 0;
    this.effects = [];
    requestAnimationFrame((t) => this.loop(t));
  }

  load(replay, names, youSide) {
    this.replay = replay;
    this.meta = replay.meta;
    this.names = names;
    this.youSide = youSide ?? null;
    this.canvas.width = this.meta.field.width;
    this.canvas.height = this.meta.field.height;
    this.i = 0;
    this.acc = 0;
    this.effects = [];
    this.playing = true;
  }

  toggle() {
    if (!this.replay) return;
    if (this.i >= this.replay.frames.length - 1) this.i = 0;
    this.playing = !this.playing;
  }
  seek(i) { this.i = Math.max(0, Math.min(i, (this.replay?.frames.length ?? 1) - 1)); this.playing = false; }

  loop(now) {
    const dt = (now - this.last) / 1000;
    this.last = now;
    for (const e of this.effects) e.age += dt * 1000;
    this.effects = this.effects.filter((e) => e.age < e.life);
    if (this.playing && this.replay) {
      this.acc += dt * this.speed;
      while (this.acc >= this.meta.dt) {
        this.acc -= this.meta.dt;
        const next = Math.min(this.i + 1, this.replay.frames.length - 1);
        if (next !== this.i) this.detect(this.replay.frames[this.i], this.replay.frames[next]);
        this.i = next;
        if (this.i >= this.replay.frames.length - 1) this.playing = false;
      }
    }
    if (this.replay) this.render(this.replay.frames[this.i]);
    if (this.onTick) this.onTick(this.i, this.replay?.frames.length ?? 0, this.playing);
    requestAnimationFrame((t) => this.loop(t));
  }

  detect(prev, cur) {
    if ((cur.ball.mode === "pass" || cur.ball.mode === "shot") && prev.ball.mode === "controlled") {
      const k = prev.players.find((p) => p.ball);
      this.spawn({ type: cur.ball.mode, playerId: k ? k.id : null, color: cur.ball.side ? COLORS[cur.ball.side] : "#fff" });
    }
    for (const a of cur.players) for (const b of cur.players) {
      if (a.side === b.side || a.id >= b.id) continue;
      if (Math.hypot(a.x - b.x, a.y - b.y) >= 26) continue;
      const pa = prev.players.find((p) => p.id === a.id);
      const pb = prev.players.find((p) => p.id === b.id);
      if (!pa || !pb || Math.hypot(pa.x - pb.x, pa.y - pb.y) >= 26) {
        this.spawn({ type: "collision", playerId: a.id, color: COLORS[a.side] });
        this.spawn({ type: "collision", playerId: b.id, color: COLORS[b.side] });
      }
    }
  }
  spawn(e) {
    this.effects.push({ ...e, age: 0, life: e.type === "shot" ? 460 : e.type === "pass" ? 340 : 260 });
    if (this.effects.length > 80) this.effects.shift();
  }

  render(f) {
    const ctx = this.ctx;
    const { width: W, height: H, goalHeight } = this.meta.field;
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = "#15602f";
    ctx.fillRect(0, 0, W, H);
    // lines
    ctx.strokeStyle = COLORS.line; ctx.lineWidth = 2;
    ctx.strokeRect(8, 8, W - 16, H - 16);
    ctx.beginPath(); ctx.moveTo(W / 2, 8); ctx.lineTo(W / 2, H - 8); ctx.stroke();
    ctx.beginPath(); ctx.arc(W / 2, H / 2, this.meta.field.centerRadius ?? 70, 0, Math.PI * 2); ctx.stroke();
    const top = (H - goalHeight) / 2;
    ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.moveTo(4, top); ctx.lineTo(4, top + goalHeight); ctx.moveTo(W - 4, top); ctx.lineTo(W - 4, top + goalHeight); ctx.stroke();
    // team name labels at each goal
    ctx.save();
    ctx.globalAlpha = 0.16; ctx.fillStyle = COLORS.home; ctx.fillRect(4, top, 22, goalHeight);
    ctx.fillStyle = COLORS.away; ctx.fillRect(W - 26, top, 22, goalHeight); ctx.globalAlpha = 1;
    ctx.font = "bold 15px ui-monospace, monospace"; ctx.textBaseline = "top";
    ctx.fillStyle = COLORS.home; ctx.textAlign = "left"; ctx.fillText(`${this.names.home} ▶`, 34, 26);
    ctx.fillStyle = COLORS.away; ctx.textAlign = "right"; ctx.fillText(`◀ ${this.names.away}`, W - 16, 26);
    ctx.restore();
    if (f.phase === "kickoff") this.drawKickoff(f);
    // players
    for (const p of f.players) {
      ctx.beginPath(); ctx.fillStyle = COLORS[p.side]; ctx.arc(p.x, p.y, PLAYER_R, 0, Math.PI * 2); ctx.fill();
      if (p.ball) { ctx.lineWidth = 3; ctx.strokeStyle = "#fff"; ctx.stroke(); }
    }
    this.drawBall(f);
    this.drawEffects(f);
  }

  drawKickoff(f) {
    const ctx = this.ctx, W = this.meta.field.width, cy = this.meta.field.height / 2, r = this.meta.field.centerRadius ?? 70;
    ctx.save(); ctx.strokeStyle = COLORS[f.kickoffSide]; ctx.lineWidth = 3; ctx.globalAlpha = 0.9;
    ctx.beginPath(); ctx.arc(W / 2, cy, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore();
  }

  drawBall(f) {
    const ctx = this.ctx;
    const { mode, side } = f.ball;
    const tint = side ? COLORS[side] : null;
    const inFlight = mode === "pass" || mode === "shot";
    const start = Math.max(1, this.i - (inFlight ? 12 : 6));
    ctx.lineCap = "round";
    for (let j = start; j <= this.i; j++) {
      const a = this.replay.frames[j - 1].ball, b = this.replay.frames[j].ball;
      const t = (j - start + 1) / (this.i - start + 1);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
      ctx.strokeStyle = inFlight ? tint ?? "#fff" : "#fff";
      ctx.globalAlpha = (inFlight ? 0.55 : 0.16) * t;
      ctx.lineWidth = inFlight ? (mode === "shot" ? 5 : 4) : 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.beginPath(); ctx.fillStyle = COLORS.ball; ctx.arc(f.ball.x, f.ball.y, 8, 0, Math.PI * 2); ctx.fill();
    if (inFlight && tint) { ctx.lineWidth = 3; ctx.strokeStyle = tint; ctx.stroke(); }
  }

  drawEffects(frame) {
    const ctx = this.ctx;
    for (const e of this.effects) {
      const p = e.playerId != null ? frame.players.find((pl) => pl.id === e.playerId) : null;
      if (!p) continue;
      const t = e.age / e.life, fade = 1 - t;
      const shot = e.type === "shot", coll = e.type === "collision";
      const r = PLAYER_R + 2 + t * (shot ? 16 : coll ? 6 : 11);
      ctx.save();
      ctx.globalAlpha = fade * (shot ? 0.6 : coll ? 0.4 : 0.45);
      ctx.strokeStyle = e.color; ctx.lineWidth = shot ? 3 : 2;
      ctx.shadowColor = e.color; ctx.shadowBlur = shot ? 16 : coll ? 7 : 11;
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  }
}
