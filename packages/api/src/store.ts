import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { libraryBots } from "@claude-ball/ladder";
import type { ParamsSpec } from "@claude-ball/arena";

export interface BotRecord {
  id: string;
  /** Owner handle; "library" for built-ins. */
  handle: string;
  name: string;
  kind: "library" | "user";
  elo: number;
  record?: { wins: number; draws: number; losses: number };
  blurb?: string;
  /** Declared knob spec (label/min/max/step/help) — non-sensitive, surfaced so the
   *  bot's knobs can be tuned live on the site. Source itself is never exposed. */
  params?: ParamsSpec;
  /** Brain source — kept server-side so any matchup can be replayed; never listed. */
  source: string;
  /** sha256 of the owner's claim key (user bots only); proves ownership on resubmit. */
  secret?: string;
  /** Tournament slug this bot belongs to (org tournaments). Tagged bots are kept
   *  off the public ladder and only appear inside their tournament. */
  tournament?: string;
  createdAt: number;
}

/** Public view of a bot (no source, no secret). */
export type PublicBot = Omit<BotRecord, "source" | "secret">;

/** A reference to a bot inside a result (by store id, so matches replay on demand). */
export interface BotRef {
  id: string;
  name: string;
  handle: string;
}
/** One league fixture, in play order. `winner` is null for a draw. */
export interface LeagueGame {
  round: number;
  a: BotRef;
  b: BotRef;
  seed: number;
  score: { a: number; b: number };
  winner: BotRef | null;
}
/** A row in the final league table (3 pts a win, 1 a draw). */
export interface Standing {
  id: string;
  name: string;
  handle: string;
  played: number;
  w: number;
  d: number;
  l: number;
  gf: number;
  ga: number;
  gd: number;
  pts: number;
}
export interface TournamentResult {
  ranAt: number;
  format: "league";
  champion: BotRef;
  games: LeagueGame[];
  standings: Standing[];
}
export interface Tournament {
  slug: string;
  org: string;
  name: string;
  orgId: string;
  tourId: string;
  status: "open" | "done";
  createdAt: number;
  result?: TournamentResult;
  /** Slack Incoming Webhook URL (secret) — when set, invites/results post to that
   *  channel. Never returned by the API. */
  slackWebhook?: string;
}

const strip = ({ source: _s, secret: _k, ...rest }: BotRecord): PublicBot => rest;
const slugify = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "x";
const rnd = () => Math.random().toString(36).slice(2, 6);

// Current on-disk source for each library bot, so library matchups always bundle
// against the code we ship (immune to stale source persisted before a rename).
const liveLibrarySource = new Map(libraryBots.map((b) => [b.name, b.source]));

export class JsonStore {
  private bots: BotRecord[] = [];
  private tours: Tournament[] = [];
  private readonly toursFile: string;

  constructor(private readonly file: string) {
    this.toursFile = file.replace(/\.json$/i, "") + ".tours.json";
    if (existsSync(file)) {
      this.bots = JSON.parse(readFileSync(file, "utf8")) as BotRecord[];
    }
    // Seed/refresh the library fixtures from the shipped catalog. Runs on every
    // boot (not just first), so a deploy that adds a new house bot or re-anchors
    // an existing one's Elo shows up on a ladder store that was seeded earlier.
    this.syncLibraryBots();
    if (existsSync(this.toursFile)) this.tours = JSON.parse(readFileSync(this.toursFile, "utf8")) as Tournament[];
  }

  /** Ensure every shipped library bot is present and Elo/blurb-anchored to the
   *  current catalog. Inserts missing fixtures (new house bots) and re-anchors
   *  existing ones; never touches user bots. Saves only if something changed. */
  private syncLibraryBots(): void {
    let changed = false;
    for (const b of libraryBots) {
      const id = `lib-${b.name}`;
      const existing = this.bots.find((x) => x.id === id);
      if (existing) {
        if (existing.elo !== b.elo || existing.blurb !== b.blurb || existing.kind !== "library") {
          existing.elo = b.elo;
          existing.blurb = b.blurb;
          existing.kind = "library";
          changed = true;
        }
      } else {
        this.bots.push({
          id,
          handle: "library",
          name: b.name,
          kind: "library",
          elo: b.elo,
          blurb: b.blurb,
          source: b.source,
          createdAt: 0,
        });
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.bots, null, 2));
  }
  private saveTours(): void {
    mkdirSync(dirname(this.toursFile), { recursive: true });
    writeFileSync(this.toursFile, JSON.stringify(this.tours, null, 2));
  }

  /** Public ladder — every bot, highest Elo first (tournament bots included;
   *  each carries its `tournament` tag so the UI can badge it). */
  leaderboard(): PublicBot[] {
    return [...this.bots].sort((a, b) => b.elo - a.elo).map(strip);
  }

  find(idOrName: string): BotRecord | undefined {
    const rec = this.bots.find((b) => b.id === idOrName || b.name === idOrName);
    if (rec && rec.kind === "library") {
      const src = liveLibrarySource.get(rec.name);
      if (src) return { ...rec, source: src };
    }
    return rec;
  }

  upsertUserBot(input: {
    handle: string;
    name: string;
    elo: number;
    source: string;
    secret: string;
    record?: BotRecord["record"];
    tournament?: string;
    params?: ParamsSpec;
  }): BotRecord {
    const id = `user-${input.handle}`;
    const existing = this.bots.find((b) => b.id === id);
    const rec: BotRecord = {
      id,
      handle: input.handle,
      name: input.name,
      kind: "user",
      elo: input.elo,
      record: input.record,
      params: input.params,
      source: input.source,
      secret: input.secret,
      // keep an existing tournament tag if this resubmit didn't specify one
      tournament: input.tournament ?? existing?.tournament,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing) Object.assign(existing, rec);
    else this.bots.push(rec);
    this.save();
    return rec;
  }

  deleteBot(id: string): boolean {
    const before = this.bots.length;
    this.bots = this.bots.filter((b) => b.id !== id);
    if (this.bots.length === before) return false;
    this.save();
    return true;
  }

  // ── tournaments ───────────────────────────────────────────────────────────
  createTournament(org: string, name: string): Tournament {
    let slug = `${slugify(org)}-${slugify(name)}`;
    while (this.tours.some((t) => t.slug === slug)) slug = `${slugify(org)}-${slugify(name)}-${rnd()}`;
    const t: Tournament = {
      slug,
      org: org.trim().slice(0, 60) || "org",
      name: name.trim().slice(0, 60) || "tournament",
      orgId: `org-${rnd()}`,
      tourId: `t-${rnd()}`,
      status: "open",
      createdAt: Date.now(),
    };
    this.tours.push(t);
    this.saveTours();
    return t;
  }
  getTournament(slug: string): Tournament | undefined {
    return this.tours.find((t) => t.slug === slug);
  }
  listTournaments(): (Omit<Tournament, "result" | "slackWebhook"> & { bots: number; champion?: string })[] {
    return [...this.tours]
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(({ result, slackWebhook, ...t }) => ({ ...t, bots: this.tournamentBots(t.slug).length, champion: result?.champion.name }));
  }
  /** Full bot records for a tournament (includes source — server-only). */
  tournamentBots(slug: string): BotRecord[] {
    return this.bots.filter((b) => b.tournament === slug);
  }
  saveTournamentResult(slug: string, result: TournamentResult): void {
    const t = this.getTournament(slug);
    if (!t) return;
    t.result = result;
    t.status = "done";
    this.saveTours();
  }
  setSlackWebhook(slug: string, url: string | undefined): void {
    const t = this.getTournament(slug);
    if (!t) return;
    t.slackWebhook = url;
    this.saveTours();
  }
}
