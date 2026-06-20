import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { libraryBots } from "@claude-ball/ladder";

export interface BotRecord {
  id: string;
  /** Owner handle; "library" for built-ins. */
  handle: string;
  name: string;
  kind: "library" | "user";
  elo: number;
  record?: { wins: number; draws: number; losses: number };
  blurb?: string;
  /** Brain source — kept server-side so any matchup can be replayed; never listed. */
  source: string;
  /** sha256 of the owner's claim key (user bots only); proves ownership on resubmit. */
  secret?: string;
  createdAt: number;
}

/** Public view of a bot (no source, no secret). */
export type PublicBot = Omit<BotRecord, "source" | "secret">;

export interface Store {
  leaderboard(): PublicBot[];
  find(idOrName: string): BotRecord | undefined;
  upsertUserBot(input: {
    handle: string;
    name: string;
    elo: number;
    source: string;
    secret: string;
    record?: BotRecord["record"];
  }): BotRecord;
  deleteBot(id: string): boolean;
}

const strip = ({ source: _s, secret: _k, ...rest }: BotRecord): PublicBot => rest;

// Current on-disk source for each library bot, so library matchups always bundle
// against the code we ship (immune to stale source persisted before a rename).
const liveLibrarySource = new Map(libraryBots.map((b) => [b.name, b.source]));

export class JsonStore implements Store {
  private bots: BotRecord[] = [];

  constructor(private readonly file: string) {
    if (existsSync(file)) {
      this.bots = JSON.parse(readFileSync(file, "utf8")) as BotRecord[];
    } else {
      this.bots = libraryBots.map((b) => ({
        id: `lib-${b.name}`,
        handle: "library",
        name: b.name,
        kind: "library" as const,
        elo: b.elo,
        blurb: b.blurb,
        source: b.source,
        createdAt: 0,
      }));
      this.save();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.bots, null, 2));
  }

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
      source: input.source,
      secret: input.secret,
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
}
