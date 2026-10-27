import { readReactionSession } from './activity-data';
import type { ReactionSession } from './contracts';

interface SessionOptions {
  read: () => unknown;
  write: (session: ReactionSession | null) => void;
  issue: (signal: AbortSignal) => Promise<unknown>;
  exclusive?: (callback: () => Promise<ReactionSession>, signal: AbortSignal) => Promise<ReactionSession>;
  now?: () => number;
}

/** The persisted token is checked inside a cross-tab lock before a new visitor is issued. */
export class ActivityVisitorSession {
  #memory: ReactionSession | null = null;

  constructor(private options: SessionOptions) {}

  #stored(): ReactionSession | null {
    try {
      return readReactionSession(this.options.read());
    } catch {
      return null;
    }
  }

  async get(signal: AbortSignal): Promise<ReactionSession> {
    const resolve = async () => {
      signal.throwIfAborted();
      const now = (this.options.now ?? Date.now)();
      const stored = this.#stored();
      const session =
        stored && Date.parse(stored.expiresAt) > now + 60_000
          ? stored
          : this.#memory && Date.parse(this.#memory.expiresAt) > now + 60_000
            ? this.#memory
            : null;
      if (session) {
        this.#memory = session;
        return session;
      }
      const issued = readReactionSession(await this.options.issue(signal));
      signal.throwIfAborted();
      if (Date.parse(issued.expiresAt) <= now + 60_000) throw new Error('Visitor session expired.');
      this.#memory = issued;
      this.options.write(issued);
      return issued;
    };
    return this.options.exclusive ? this.options.exclusive(resolve, signal) : resolve();
  }

  invalidate(token: string | null) {
    if (token === null || this.#memory?.token === token) this.#memory = null;
    const stored = this.#stored();
    // A delayed rejection in one tab must not erase a renewed token from another tab.
    if (stored && (token === null || stored.token === token)) this.options.write(null);
  }
}

export function reactionRetryAction(status: number | null, attempt: number): 'renew-session' | 'retry' | 'stop' {
  if (attempt !== 0) return 'stop';
  if (status === 401 || status === 403) return 'renew-session';
  return status === null || status === 0 || status >= 500 ? 'retry' : 'stop';
}
