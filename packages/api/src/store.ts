import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { libraryBots } from "@kr/ladder";

export interface BotRecord {
  id: string;
  /** Owner handle; "library" for built-ins. */
  handle: string;
  name: string;
  kind: "library" | "user";
  elo: number;
  record?: { wins: number; draws: number; losses: number };
  blurb?: string;
  createdAt: number;
}

/**
 * Persistence behind a tiny interface so we can swap the local JSON store for
 * Postgres in production without touching the server. One active bot per user
 * handle (a resubmit replaces it).
 */
export interface Store {
  leaderboard(): BotRecord[];
  upsertUserBot(input: { handle: string; name: string; elo: number; record?: BotRecord["record"] }): BotRecord;
}

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
        createdAt: 0,
      }));
      this.save();
    }
  }

  private save(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.bots, null, 2));
  }

  leaderboard(): BotRecord[] {
    return [...this.bots].sort((a, b) => b.elo - a.elo);
  }

  upsertUserBot(input: { handle: string; name: string; elo: number; record?: BotRecord["record"] }): BotRecord {
    const id = `user-${input.handle}`;
    const existing = this.bots.find((b) => b.id === id);
    const rec: BotRecord = {
      id,
      handle: input.handle,
      name: input.name,
      kind: "user",
      elo: input.elo,
      record: input.record,
      createdAt: existing?.createdAt ?? Date.now(),
    };
    if (existing) Object.assign(existing, rec);
    else this.bots.push(rec);
    this.save();
    return rec;
  }
}
