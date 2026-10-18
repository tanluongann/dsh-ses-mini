/**
 * The seen set: what has already been handed to the agent, and for how long we remember.
 *
 * Two identities go in, for two different reasons:
 *   - `msg:<Message-ID>` is the mail identity the config asks for, and the one that survives
 *     an SES redelivery or a second S3 object for the same message;
 *   - `obj:<s3 key>` is the storage identity, and it is what stops a poll from downloading
 *     the same object over and over while the message id is deliberately forgotten.
 *
 * Both are bounded by a TTL and a size cap, and both are loaded from disk at arm time — a
 * restart that reprocessed yesterday's inbox would answer the owner's mail twice, which
 * reads as a broken agent rather than a broken channel.
 *
 * The TTL is also the age limit for unprocessed mail (see `bot.pollOnce`): past it, an
 * object is left alone rather than re-answered, so pruning can never resurrect a message.
 */
export class SeenSet {
  constructor({ ttlMs = 14 * 24 * 60 * 60_000, maxEntries = 2_000, now = Date.now } = {}) {
    this.ttlMs = Number.isFinite(ttlMs) && ttlMs > 0 ? ttlMs : 14 * 24 * 60 * 60_000
    this.maxEntries = Number.isFinite(maxEntries) && maxEntries > 0 ? Math.floor(maxEntries) : 2_000
    this.now = now
    /** @type {Map<string, number>} key → first seen (epoch ms) */
    this.map = new Map()
  }

  get size() {
    return this.map.size
  }

  /** Persistable view: the plain object the state file stores. */
  entries() {
    return Object.fromEntries(this.map)
  }

  /** Load a persisted map. Pruning here is not hygiene: an expired file must not replay mail. */
  load(entries) {
    this.map = new Map()
    if (entries !== null && typeof entries === 'object') {
      for (const [key, at] of Object.entries(entries)) {
        const stamp = Number(at)
        if (typeof key === 'string' && key !== '' && Number.isFinite(stamp)) this.map.set(key, stamp)
      }
    }
    this.prune()
    return this
  }

  /** Whether this identity was seen recently. An expired entry is absent, and is dropped. */
  has(key) {
    const at = this.map.get(key)
    if (at === undefined) return false
    if (this.now() - at > this.ttlMs) {
      this.map.delete(key)
      return false
    }
    return true
  }

  /** Record an identity. Returns true when it was new (i.e. this is the first sighting). */
  add(key) {
    if (typeof key !== 'string' || key === '') return false
    const fresh = !this.has(key)
    this.map.set(key, this.now())
    this.prune()
    return fresh
  }

  /**
   * Drop expired entries, then — if the cap is still exceeded — the oldest ones.
   *
   * The second pass matters: a flood inside one TTL window would otherwise grow the state
   * file without bound, and the file is rewritten on every accepted message.
   */
  prune() {
    const now = this.now()
    for (const [key, at] of this.map) {
      if (now - at > this.ttlMs) this.map.delete(key)
    }
    if (this.map.size <= this.maxEntries) return this
    const oldestFirst = [...this.map.entries()].sort((a, b) => a[1] - b[1])
    for (const [key] of oldestFirst.slice(0, this.map.size - this.maxEntries)) this.map.delete(key)
    return this
  }
}
