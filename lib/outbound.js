/**
 * Outbound pipe — CHANNEL-CONTRACT §3/§4: file-based outbound spool with the
 * politeness layer. Anything on the host (scripts, monitors, the agent) emits
 * an outbound event by dropping a JSON file into `<cwd>/channel-outbound/`:
 *
 *   { "to": "primary" | "<chatId>", "class": "alert" | "note" | "chatter",
 *     "text": "markdown", "source": "drift-check" }
 *
 * Politeness: `alert` delivers immediately; `note` is rate-limited (budget per
 * rolling hour, overflow held); `chatter` respects quiet hours (held during
 * the window). Identical to+text within the dedup window collapses. Held ≠
 * dropped: held files keep a `.reason` sidecar and are re-evaluated every
 * tick; deduped and delivered files move to `delivered/`, pruned after 7 days.
 * A delivery failure leaves the file in the inbox, retried and logged every
 * tick — a composed message that is never delivered must never hide.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const statSyncSafe = (path) => {
  try {
    return statSync(path).mtimeMs
  } catch {
    return undefined
  }
}

const HELD = 'held'
const DELIVERED = 'delivered'
const PRUNE_MS = 7 * 24 * 3600 * 1000
const TICK_MS = 5_000

const hashOf = (to, text) => createHash('sha1').update(`${to}\u0000${text}`).digest('hex')

/** `'23:00-08:00'` → minutes pair; `''` → undefined (never quiet). */
export function quietMinutes(spec) {
  if (typeof spec !== 'string' || spec.trim() === '') return undefined
  const [a = '', b = ''] = spec.split('-')
  const pa = /^(\d{1,2}):(\d{2})$/.exec(a.trim())
  const pb = /^(\d{1,2}):(\d{2})$/.exec(b.trim())
  if (pa === null || pb === null) return undefined
  return [Number(pa[1]) * 60 + Number(pa[2]), Number(pb[1]) * 60 + Number(pb[2])]
}

export class OutboundPipe {
  constructor({ ctx, config, channel, sender, logger, cwd, now = () => Date.now() }) {
    this.ctx = ctx
    this.config = config
    this.channel = channel
    this.sender = sender // the bot: its sendMarkdown carries the full delivery pipeline (webhook fallback included)
    this.logger = logger ?? console
    this.now = now
    this.dir = join(cwd, 'channel-outbound')
    this.timer = undefined
    this.busy = false
    this.state = { notes: [], dedup: {} }
  }

  start() {
    this.setup()
    void this.tick() // crash recovery: the inbox drains before anything new
    this.timer = setInterval(() => { void this.tick() }, TICK_MS)
    this.timer.unref?.()
    this.logger.info?.(`ses-mini: outbound pipe live — ${this.dir}`)
  }

  /** Create the spool layout and load politeness state. Idempotent. */
  setup() {
    for (const d of [this.dir, join(this.dir, HELD), join(this.dir, DELIVERED)]) {
      mkdirSync(d, { recursive: true })
    }
    this.state = this.readJson('.state.json', this.state)
  }

  dispose() {
    if (this.timer !== undefined) clearInterval(this.timer)
    this.timer = undefined
  }

  async tick() {
    if (this.busy) return
    this.busy = true
    try {
      this.promoteHeld()
      for (const name of this.jsonFiles('')) {
        const event = this.readJson(name)
        if (event === undefined) {
          this.move(name, HELD, 'unparsable') // quarantine, never delete
          continue
        }
        const chat = this.resolveTo(event)
        if (chat === undefined) {
          this.move(name, HELD, 'no-primary-chat')
          continue
        }
        const decision = this.gate(chat, event)
        if (decision.hold !== undefined) {
          this.move(name, HELD, decision.hold)
          continue
        }
        if (decision.dedup === true) {
          this.move(name, DELIVERED, 'deduped')
          continue
        }
        if (await this.deliver(chat, event)) {
          this.account(event)
          this.move(name, DELIVERED, 'delivered')
        } // else: stays in the inbox, retried next tick
      }
      this.prune()
      this.writeJson('.state.json', this.state)
    } catch (error) {
      this.logger.warn?.(`ses-mini: outbound tick failed: ${error?.message ?? String(error)}`)
    } finally {
      this.busy = false
    }
  }

  // -------------------------------------------------------------- politeness --

  /** `deliver` | `{dedup}` | `{hold: reason}` — never throws. */
  gate(chat, event) {
    const at = this.now()
    const windowMs = Math.max(0, Number(this.config.politenessDedupWindowMinutes) || 0) * 60_000
    if (windowMs > 0) {
      const h = hashOf(chat, event.text)
      const seen = this.state.dedup[h]
      if (seen !== undefined && at - seen < windowMs) return { dedup: true }
    }
    const klass = event.class === 'note' || event.class === 'chatter' ? event.class : 'alert'
    if (klass === 'note') {
      const budget = Number(this.config.politenessNoteRatePerHour)
      this.state.notes = this.state.notes.filter((ts) => at - ts < 3600_000)
      if (Number.isFinite(budget) && budget > 0 && this.state.notes.length >= budget) {
        return { hold: 'note-budget' }
      }
    }
    if (klass === 'chatter') {
      if (String(this.config.politenessChatter) === 'never') return { hold: 'chatter-never' }
      const q = quietMinutes(this.config.politenessQuietHours)
      if (q !== undefined && this.inQuiet(at, q)) return { hold: 'quiet-hours' }
    }
    return { deliver: true }
  }

  inQuiet(at, [start, end]) {
    const m = new Date(at).getHours() * 60 + new Date(at).getMinutes()
    return start <= end ? m >= start && m < end : m >= start || m < end
  }

  account(event) {
    const at = this.now()
    if (event.class === 'note') this.state.notes.push(at)
    const h = hashOf(this.resolveTo(event) ?? '', event.text)
    this.state.dedup[h] = at
    for (const [k, ts] of Object.entries(this.state.dedup)) {
      if (at - ts > 24 * 3600_000) delete this.state.dedup[k]
    }
  }

  // ------------------------------------------------------------- mechanics --

  resolveTo(event) {
    const to = typeof event.to === 'string' && event.to !== '' ? event.to : 'primary'
    if (to !== 'primary') return to
    const primary = this.config.outboundPrimaryChat
    return typeof primary === 'string' && primary !== '' ? primary : undefined
  }

  async deliver(chat, event) {
    const send = this.sender?.sendMarkdown?.bind(this.sender) ?? this.channel?.sendMarkdown?.bind(this.channel)
    if (typeof send !== 'function') {
      this.logger.warn?.('ses-mini: outbound — no sendMarkdown on bot or channel; event held in inbox')
      return false
    }
    try {
      await send(chat, String(event.text ?? ''))
      this.logger.info?.(`ses-mini: outbound ${event.class} -> ${chat} (${event.source ?? 'unknown'})`)
      return true
    } catch (error) {
      this.logger.warn?.(`ses-mini: outbound delivery failed (will retry): ${error?.message ?? String(error)}`)
      return false
    }
  }

  promoteHeld() {
    const at = this.now()
    for (const name of this.jsonFiles(HELD)) {
      const reason = this.reasonOf(HELD, name)
      if (reason === 'note-budget') {
        const budget = Number(this.config.politenessNoteRatePerHour)
        this.state.notes = this.state.notes.filter((ts) => at - ts < 3600_000)
        if (!Number.isFinite(budget) || budget <= 0 || this.state.notes.length < budget) this.unhold(name)
      } else if (reason === 'quiet-hours') {
        const q = quietMinutes(this.config.politenessQuietHours)
        if (q === undefined || !this.inQuiet(at, q)) this.unhold(name)
      } // 'unparsable' and 'no-primary-chat' stay until an operator acts
    }
  }

  prune() {
    const at = this.now()
    for (const name of this.jsonFiles(DELIVERED)) {
      try {
        const path = join(this.dir, DELIVERED, name)
        const mtimeMs = statSyncSafe(path)
        if (mtimeMs !== undefined && at - mtimeMs > PRUNE_MS) rmSync(path, { force: true })
      } catch { /* pruning is best-effort */ }
    }
  }

  move(name, sub, outcome) {
    const from = join(this.dir, name)
    const to = join(this.dir, sub, name)
    try {
      renameSync(from, to)
      if (sub === HELD) writeFileSync(`${to}.reason`, `${outcome}\n`, { mode: 0o600 })
      else if (sub === DELIVERED && outcome !== undefined) writeFileSync(`${to}.outcome`, `${outcome}\n`, { mode: 0o600 })
    } catch (error) {
      this.logger.warn?.(`ses-mini: outbound move ${name} -> ${sub} failed: ${error?.message ?? String(error)}`)
    }
  }

  unhold(name) {
    try {
      renameSync(join(this.dir, HELD, name), join(this.dir, name))
      rmSync(join(this.dir, HELD, `${name}.reason`), { force: true })
      this.logger.info?.(`ses-mini: outbound released from held/ — ${name}`)
    } catch { /* raced a concurrent move; next tick re-evaluates */ }
  }

  jsonFiles(sub) {
    try {
      return readdirSync(join(this.dir, sub)).filter((f) => f.endsWith('.json') && !f.startsWith('.')).sort()
    } catch {
      return []
    }
  }

  reasonOf(sub, name) {
    try {
      return readFileSync(join(this.dir, sub, `${name}.reason`), 'utf8').trim()
    } catch {
      return undefined
    }
  }

  readJson(name, fallback = undefined) {
    try {
      return JSON.parse(readFileSync(join(this.dir, name), 'utf8'))
    } catch {
      return fallback
    }
  }

  writeJson(name, value) {
    try {
      writeFileSync(join(this.dir, name), JSON.stringify(value), { mode: 0o600 })
    } catch (error) {
      this.logger.warn?.(`ses-mini: outbound state write failed: ${error?.message ?? String(error)}`)
    }
  }
}
