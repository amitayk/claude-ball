// Render shareable highlight GIFs of arena matches.
// Runs real engine matches, picks a ~15s window containing 1-2 goals,
// rasterises each frame in pure JS (same look as the web viewer), burns in a
// live scoreboard, and pipes raw frames to ffmpeg to encode the gif.
//
//   node_modules/.bin/tsx scripts/make-gifs.ts
//
// Output: docs/gifs/*.gif  (docs/ is gitignored)
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { runMatch, type MatchResult, type ReplayFrame } from "../packages/engine/src/match.js";
import { brains } from "../packages/brains/src/index.js";

const FONT = "/System/Library/Fonts/Supplemental/Arial Bold.ttf";
const OUT_DIR = "docs/gifs";
const OUT_W = 720; // gif width; height follows field aspect
const WINDOW_TICKS = 15 * 30; // ~15s at 30 ticks/s
const TAIL_TICKS = 75; // keep ~2.5s after the last goal in the window

const C = {
  home: [79, 157, 255] as RGB,
  away: [255, 210, 74] as RGB,
  ball: [255, 255, 255] as RGB,
  pitch: [21, 96, 47] as RGB,
  white: [255, 255, 255] as RGB,
};
type RGB = [number, number, number];

// ---------- framebuffer ----------
class FB {
  buf: Uint8ClampedArray;
  constructor(public w: number, public h: number) {
    this.buf = new Uint8ClampedArray(w * h * 3);
  }
  clear([r, g, b]: RGB) {
    const n = this.w * this.h;
    for (let i = 0; i < n; i++) {
      this.buf[i * 3] = r;
      this.buf[i * 3 + 1] = g;
      this.buf[i * 3 + 2] = b;
    }
  }
  px(x: number, y: number, [r, g, b]: RGB, a: number) {
    if (a <= 0 || x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    if (a > 1) a = 1;
    const i = (y * this.w + x) * 3;
    this.buf[i] = r * a + this.buf[i] * (1 - a);
    this.buf[i + 1] = g * a + this.buf[i + 1] * (1 - a);
    this.buf[i + 2] = b * a + this.buf[i + 2] * (1 - a);
  }
  rect(x: number, y: number, w: number, h: number, col: RGB, a = 1) {
    const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
    const x1 = Math.min(this.w, Math.ceil(x + w)), y1 = Math.min(this.h, Math.ceil(y + h));
    for (let yy = y0; yy < y1; yy++) for (let xx = x0; xx < x1; xx++) this.px(xx, yy, col, a);
  }
  disc(cx: number, cy: number, r: number, col: RGB, a = 1) {
    const x0 = Math.floor(cx - r - 1), x1 = Math.ceil(cx + r + 1);
    const y0 = Math.floor(cy - r - 1), y1 = Math.ceil(cy + r + 1);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const d = Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy);
      const cov = Math.max(0, Math.min(1, r + 0.5 - d));
      if (cov > 0) this.px(xx, yy, col, a * cov);
    }
  }
  ring(cx: number, cy: number, r: number, lw: number, col: RGB, a = 1) {
    const x0 = Math.floor(cx - r - lw), x1 = Math.ceil(cx + r + lw);
    const y0 = Math.floor(cy - r - lw), y1 = Math.ceil(cy + r + lw);
    for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) {
      const d = Math.abs(Math.hypot(xx + 0.5 - cx, yy + 0.5 - cy) - r);
      const cov = Math.max(0, Math.min(1, lw / 2 + 0.5 - d));
      if (cov > 0) this.px(xx, yy, col, a * cov);
    }
  }
  seg(x0: number, y0: number, x1: number, y1: number, lw: number, col: RGB, a = 1) {
    const minx = Math.floor(Math.min(x0, x1) - lw), maxx = Math.ceil(Math.max(x0, x1) + lw);
    const miny = Math.floor(Math.min(y0, y1) - lw), maxy = Math.ceil(Math.max(y0, y1) + lw);
    const dx = x1 - x0, dy = y1 - y0, len2 = dx * dx + dy * dy || 1;
    for (let yy = miny; yy <= maxy; yy++) for (let xx = minx; xx <= maxx; xx++) {
      let t = ((xx + 0.5 - x0) * dx + (yy + 0.5 - y0) * dy) / len2;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(xx + 0.5 - (x0 + t * dx), yy + 0.5 - (y0 + t * dy));
      const cov = Math.max(0, Math.min(1, lw / 2 + 0.5 - d));
      if (cov > 0) this.px(xx, yy, col, a * cov);
    }
  }
}

// ---------- 5x7 digit font for the live score ----------
const GLYPH: Record<string, string[]> = {
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
};
function glyphW(s: number) { return 5 * s; }
function drawGlyph(fb: FB, ch: string, x: number, y: number, s: number, col: RGB) {
  const g = GLYPH[ch];
  if (!g) return;
  for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) {
    if (g[r]![c] === "1") fb.rect(x + c * s, y + r * s, s, s, col);
  }
}

// ---------- scene render ----------
const PLAYER_R = 12, BALL_R = 8;
interface Effect { kind: "pass" | "shot"; pid: number; age: number; life: number; col: RGB }

function drawField(fb: FB, m: MatchResult["meta"]) {
  const { width: W, height: H, goalHeight } = m.field;
  fb.clear(C.pitch);
  const line: RGB = C.white;
  // border + halfway + centre circle (faint white)
  fb.rect(8, 8, W - 16, 2, line, 0.22); fb.rect(8, H - 10, W - 16, 2, line, 0.22);
  fb.rect(8, 8, 2, H - 16, line, 0.22); fb.rect(W - 10, 8, 2, H - 16, line, 0.22);
  fb.rect(W / 2 - 1, 8, 2, H - 16, line, 0.22);
  fb.ring(W / 2, H / 2, 70, 2, line, 0.22);
  // goals + faint team end-zones
  const top = (H - goalHeight) / 2;
  fb.rect(2, top, 4, goalHeight, line, 0.85);
  fb.rect(W - 6, top, 4, goalHeight, line, 0.85);
  fb.rect(4, top, 22, goalHeight, C.home, 0.16);
  fb.rect(W - 26, top, 22, goalHeight, C.away, 0.16);
}

function drawScore(fb: FB, f: ReplayFrame, W: number) {
  const s = 6, gw = glyphW(s), gap = Math.round(gw * 0.4);
  const seq: { ch: string; col: RGB }[] = [];
  for (const ch of String(f.score.home)) seq.push({ ch, col: C.home });
  seq.push({ ch: "-", col: C.white });
  for (const ch of String(f.score.away)) seq.push({ ch, col: C.away });
  const totalW = seq.length * gw + (seq.length - 1) * gap;
  let x = Math.round(W / 2 - totalW / 2);
  const y = 16;
  fb.rect(x - 16, y - 8, totalW + 32, 7 * s + 16, [0, 0, 0], 0.45);
  for (const { ch, col } of seq) { drawGlyph(fb, ch, x, y, s, col); x += gw + gap; }
}

function renderFrame(fb: FB, rep: MatchResult, gi: number, fx: Effect[]) {
  const f = rep.frames[gi]!;
  drawField(fb, rep.meta);
  if (f.phase === "kickoff") fb.ring(rep.meta.field.width / 2, rep.meta.field.height / 2, 70, 3, C[f.kickoffSide], 0.9);
  // ball trail
  const inFlight = f.ball.mode === "pass" || f.ball.mode === "shot";
  const tint: RGB = f.ball.side ? C[f.ball.side] : C.ball;
  const start = Math.max(1, gi - (inFlight ? 12 : 6));
  for (let j = start; j <= gi; j++) {
    const a = rep.frames[j - 1]!.ball, b = rep.frames[j]!.ball;
    const t = (j - start + 1) / (gi - start + 1);
    fb.seg(a.x, a.y, b.x, b.y, inFlight ? (f.ball.mode === "shot" ? 5 : 4) : 2, inFlight ? tint : C.ball, (inFlight ? 0.55 : 0.16) * t);
  }
  // players
  for (const p of f.players) {
    fb.disc(p.x, p.y, PLAYER_R, C[p.side]);
    if (p.ball) fb.ring(p.x, p.y, PLAYER_R, 3, C.white);
  }
  // effects (shot / pass halos)
  for (const e of fx) {
    const p = f.players.find((pl) => pl.id === e.pid);
    if (!p) continue;
    const t = e.age / e.life;
    fb.ring(p.x, p.y, PLAYER_R + 2 + t * (e.kind === "shot" ? 16 : 11), e.kind === "shot" ? 3 : 2, e.col, (1 - t) * (e.kind === "shot" ? 0.6 : 0.45));
  }
  // ball
  fb.disc(f.ball.x, f.ball.y, BALL_R, C.ball);
  if (inFlight && f.ball.side) fb.ring(f.ball.x, f.ball.y, BALL_R, 3, tint);
  drawScore(fb, f, rep.meta.field.width);
}

// ---------- window picking ----------
function goalTicks(rep: MatchResult): number[] {
  const out: number[] = [];
  for (let i = 1; i < rep.frames.length; i++) {
    const a = rep.frames[i - 1]!.score, b = rep.frames[i]!.score;
    if (b.home + b.away > a.home + a.away) out.push(i);
  }
  return out;
}
interface Win { start: number; end: number; goals: number; score: number }
// Find the best ~15s window holding only 1-2 goals (these bots score a lot, so
// such quiet-then-strike windows are the watchable ones). Each goal is tried as
// the clip's closing goal; we prefer two well-spaced goals for pacing.
function pickWindow(rep: MatchResult): Win | null {
  const gs = goalTicks(rep);
  if (!gs.length) return null;
  let best: Win | null = null;
  for (const g of gs) {
    const end = Math.min(rep.frames.length - 1, g + TAIL_TICKS);
    const start = Math.max(0, end - WINDOW_TICKS);
    const inWin = gs.filter((x) => x >= start && x <= end);
    if (inWin.length < 1 || inWin.length > 2) continue;
    const spread = (inWin[inWin.length - 1]! - inWin[0]!) / 30; // seconds between first & last
    const score = (inWin.length === 2 ? 100 : 35) + (inWin.length === 2 ? Math.min(spread, 9) : 0);
    if (!best || score > best.score) best = { start, end, goals: inWin.length, score };
  }
  return best;
}

// ---------- ffmpeg ----------
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
function encode(path: string, home: string, away: string): { ff: ReturnType<typeof spawn>; done: Promise<void> } {
  const dt = (c: RGB) => "0x" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
  const txt = (t: string, color: RGB, xExpr: string) =>
    `drawtext=fontfile='${FONT}':text='${t}':fontcolor=${dt(color)}:fontsize=24:x=${xExpr}:y=14:box=1:boxcolor=black@0.5:boxborderw=8`;
  const fg = [
    `fps=30`, // 1:1 with the 30 tick/s sim — smoothest truthful rate (no interpolation)
    `scale=${OUT_W}:-1:flags=lanczos`,
    txt(cap(home), C.home, "18"),
    txt(cap(away), C.away, "w-tw-18"),
    `split[a][b];[a]palettegen=stats_mode=diff[p];[b][p]paletteuse=dither=bayer:bayer_scale=3`,
  ].join(",");
  const fgFile = `${OUT_DIR}/.fg.txt`;
  writeFileSync(fgFile, fg);
  const ff = spawn("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pixel_format", "rgb24", "-video_size", "1050x680", "-framerate", "30", "-i", "pipe:0",
    "-filter_complex_script", fgFile, path,
  ], { stdio: ["pipe", "inherit", "inherit"] });
  ff.stdin!.on("error", () => {}); // ignore EPIPE if ffmpeg dies early
  const done = new Promise<void>((res, rej) => {
    ff.on("close", (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exited ${code}`))));
  });
  return { ff, done };
}
function write(ff: ReturnType<typeof spawn>, buf: Uint8ClampedArray): Promise<void> {
  return new Promise((res) => {
    const ok = ff.stdin!.write(Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength));
    if (ok) res(); else ff.stdin!.once("drain", () => res());
  });
}

// ---------- main ----------
const PAIRS: [string, string][] = [
  ["blitz", "chaser"],
  ["blitz", "formation"],
  ["chaser", "formation"],
  ["blitz", "flow"],
  ["formation", "flow"],
  ["chaser", "flow"],
];

mkdirSync(OUT_DIR, { recursive: true });
const fb = new FB(1050, 680);
const picks: { home: string; away: string; seed: number; rep: MatchResult; win: Win }[] = [];

// For each pairing, scan many seeds and keep the highest-scoring 1-2 goal window.
for (const [home, away] of PAIRS) {
  let bestSeed = -1, bestRep: MatchResult | null = null, bestWin: Win | null = null;
  for (let seed = 1; seed <= 40; seed++) {
    const rep = runMatch(brains[home]!, brains[away]!, { seed });
    const win = pickWindow(rep);
    if (!win) continue;
    if (!bestWin || win.score > bestWin.score) { bestWin = win; bestRep = rep; bestSeed = seed; }
    if (bestWin.goals === 2 && bestWin.score >= 107) break; // two well-spaced goals: good enough
  }
  if (bestWin && bestRep) picks.push({ home, away, seed: bestSeed, rep: bestRep, win: bestWin });
  if (picks.length >= 5) break;
}

console.log(`Selected ${picks.length} clips:`);
let n = 0;
for (const p of picks) {
  n++;
  const sc = p.rep.score;
  const name = `${String(n).padStart(2, "0")}-${p.home}-vs-${p.away}-s${p.seed}.gif`;
  const secs = ((p.win.end - p.win.start) / 30).toFixed(1);
  console.log(`  ${name}  final ${sc.home}-${sc.away}  window ${secs}s  goals-in-window ${p.win.goals}`);
  const { ff, done } = encode(`${OUT_DIR}/${name}`, p.home, p.away);
  const fx: Effect[] = [];
  for (let gi = p.win.start; gi <= p.win.end; gi++) {
    // spawn pass/shot halos on transition
    if (gi > 0) {
      const prev = p.rep.frames[gi - 1]!, cur = p.rep.frames[gi]!;
      if ((cur.ball.mode === "pass" || cur.ball.mode === "shot") && prev.ball.mode === "controlled") {
        const kicker = prev.players.find((pl) => pl.ball);
        if (kicker) fx.push({ kind: cur.ball.mode, pid: kicker.id, age: 0, life: cur.ball.mode === "shot" ? 0.46 : 0.34, col: cur.ball.side ? C[cur.ball.side] : C.ball });
      }
    }
    renderFrame(fb, p.rep, gi, fx);
    await write(ff, fb.buf);
    for (const e of fx) e.age += 1 / 30;
    for (let k = fx.length - 1; k >= 0; k--) if (fx[k]!.age >= fx[k]!.life) fx.splice(k, 1);
  }
  ff.stdin!.end();
  await done;
}
console.log(`\nDone. ${picks.length} gifs in ${OUT_DIR}/`);
