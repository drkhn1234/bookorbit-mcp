import { createHmac, randomBytes } from "node:crypto";
import { BookOrbitClient, type ClientConfig } from "./bookorbit-client.js";

type User = { username: string; password?: string };

/** Reuse upstream tokens across transports, without sharing between credentials. */
export class UserClientPool {
  private readonly key = randomBytes(32);
  private readonly clients = new Map<
    string,
    { client: BookOrbitClient; usedAt: number }
  >();

  constructor(
    private readonly baseUrl: string,
    private readonly fetchImpl?: ClientConfig["fetchImpl"],
  ) {}

  get(user: User): BookOrbitClient {
    const now = Date.now();
    // Keep reconnects cheap; release credentials for accounts idle for a day.
    for (const [key, entry] of this.clients) {
      if (now - entry.usedAt > 86_400_000) this.clients.delete(key);
    }
    const key = createHmac("sha256", this.key)
      .update(JSON.stringify([user.username, user.password ?? null]))
      .digest("hex");
    let entry = this.clients.get(key);
    if (!entry) {
      entry = {
        client: new BookOrbitClient({
          baseUrl: this.baseUrl,
          ...user,
          fetchImpl: this.fetchImpl,
        }),
        usedAt: now,
      };
      this.clients.set(key, entry);
    }
    entry.usedAt = now;
    return entry.client;
  }
}
