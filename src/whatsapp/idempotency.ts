/**
 * Tiny LRU for `POST /whatsapp/send` idempotency.
 *
 * The BB client generates a ULID `clientMsgId` for every send. If the HTTP
 * request is retried (flaky cellular, 25s timeouts, etc.) we must not send a
 * duplicate message to WhatsApp — we return the prior serverMsgId instead.
 *
 * In-memory only. Entries evict on Map insertion order once over capacity.
 * Process restart forgets them, which is fine — the BB state layer upgrades
 * "sending" bubbles to "sent" on first response and will not retry once
 * acked.
 */
export class SendIdempotencyCache {
  private readonly map = new Map<string, string>();

  constructor(private readonly capacity: number = 500) {}

  /** Returns the cached serverMsgId for a clientMsgId, or null. */
  get(clientMsgId: string): string | null {
    const hit = this.map.get(clientMsgId);
    if (hit === undefined) return null;
    // Refresh LRU position.
    this.map.delete(clientMsgId);
    this.map.set(clientMsgId, hit);
    return hit;
  }

  set(clientMsgId: string, serverMsgId: string): void {
    if (this.map.has(clientMsgId)) {
      this.map.delete(clientMsgId);
    } else if (this.map.size >= this.capacity) {
      // Evict the oldest — Map preserves insertion order.
      const first = this.map.keys().next();
      if (!first.done) this.map.delete(first.value);
    }
    this.map.set(clientMsgId, serverMsgId);
  }
}
