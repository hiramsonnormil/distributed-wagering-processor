import type { IntegrationEvent } from "./integration-event";

export interface OutboxMessageState {
  id: string;
  aggregateId: string;
  eventType: string;
  payload: Readonly<Record<string, unknown>>;
  occurredAt: Date;
  attempts: number;
  nextAttemptAt?: Date;
  publishedAt?: Date;
}

const BASE_DELAY_MS = 500;
const MAX_DELAY_MS = 60_000;

export class OutboxMessage {
  private constructor(
    public readonly id: string,
    public readonly aggregateId: string,
    public readonly eventType: string,
    public readonly payload: Readonly<Record<string, unknown>>,
    public readonly occurredAt: Date,
    private _attempts: number,
    private _nextAttemptAt?: Date,
    private _publishedAt?: Date,
  ) {}

  static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
    const json = event.toJSON();
    return new OutboxMessage(json.eventId, json.aggregateId, json.eventType, json, event.occurredAt, 0, event.occurredAt);
  }

  static rehydrate(s: OutboxMessageState): OutboxMessage {
    return new OutboxMessage(s.id, s.aggregateId, s.eventType, s.payload, s.occurredAt, s.attempts, s.nextAttemptAt, s.publishedAt);
  }

  get attempts() {
    return this._attempts;
  }
  get nextAttemptAt() {
    return this._nextAttemptAt;
  }
  get publishedAt() {
    return this._publishedAt;
  }

  isPending(): boolean {
    return this._publishedAt === undefined;
  }

  isDue(now: Date): boolean {
    return this.isPending() && (!this._nextAttemptAt || this._nextAttemptAt <= now);
  }

  markPublished(at: Date): void {
    this._publishedAt ??= at;
  }

  /** Backoff exponencial com teto, + jitter para espalhar publishers concorrentes. */
  scheduleRetry(now: Date): void {
    this._attempts += 1;
    const delay = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * 2 ** this._attempts);
    const jitter = Math.floor(Math.random() * (delay / 4));
    this._nextAttemptAt = new Date(now.getTime() + delay + jitter);
  }
}
