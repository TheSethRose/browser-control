/**
 * Bounded in-process buffer for asynchronous CDP events.
 *
 * The protocol delivers events asynchronously; an agent invoking one operation at a
 * time cannot hold a live callback. The connection appends events here and operations
 * drain or await them later.
 */

export type CdpEvent = {
  seq: number;
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
  at: number;
};

export type EventFilter = {
  method?: string;
  sessionId?: string;
  sinceSeq?: number;
};

export type EventMatcher = {
  method: string;
  match?: Record<string, unknown>;
  sessionId?: string;
};

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
}

/** Shallow subset check: every key in `match` must deep-equal the same key in `params`. */
export function matchesSubset(params: unknown, match: Record<string, unknown> | undefined): boolean {
  if (!match || Object.keys(match).length === 0) return true;
  if (typeof params !== "object" || params === null) return false;
  const p = params as Record<string, unknown>;
  return Object.keys(match).every((key) => deepEqual(p[key], match[key]));
}

export function eventMatches(event: CdpEvent, matcher: EventMatcher): boolean {
  if (event.method !== matcher.method) return false;
  if (matcher.sessionId !== undefined && event.sessionId !== matcher.sessionId) return false;
  return matchesSubset(event.params, matcher.match);
}

export class EventBuffer {
  private events: CdpEvent[] = [];
  private seq = 0;
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(method: string, params: Record<string, unknown>, sessionId?: string, at = Date.now()): CdpEvent {
    const event: CdpEvent = { seq: ++this.seq, method, params, sessionId, at };
    this.events.push(event);
    while (this.events.length > this.limit) {
      this.events.shift();
      this.dropped += 1;
    }
    return event;
  }

  /** Return the first buffered event matching `matcher`, removing it when `remove` is true. */
  take(matcher: EventMatcher, remove = true): CdpEvent | undefined {
    const index = this.events.findIndex((event) => eventMatches(event, matcher));
    if (index < 0) return undefined;
    if (!remove) return this.events[index];
    return this.events.splice(index, 1)[0];
  }

  filter(filter: EventFilter, limit: number): CdpEvent[] {
    let out = this.events.filter((event) => {
      if (filter.method !== undefined && event.method !== filter.method) return false;
      if (filter.sessionId !== undefined && event.sessionId !== filter.sessionId) return false;
      if (filter.sinceSeq !== undefined && event.seq < filter.sinceSeq) return false;
      return true;
    });
    if (limit > 0) out = out.slice(0, limit);
    return out;
  }

  remove(events: CdpEvent[]): void {
    const seqs = new Set(events.map((event) => event.seq));
    this.events = this.events.filter((event) => !seqs.has(event.seq));
  }

  clear(): void {
    this.events = [];
    this.dropped = 0;
  }

  get size(): number {
    return this.events.length;
  }

  get droppedCount(): number {
    return this.dropped;
  }

  resetDropped(): void {
    this.dropped = 0;
  }

  get nextSeq(): number {
    return this.seq + 1;
  }
}
