/**
 * The bot: email in, DSH session out, an answer mail back.
 *
 * Owns four things and nothing else:
 *   1. the poll loop (S3 prefix → messages) and the inbound policy — allowlist, loop guards,
 *      dedup;
 *   2. correspondent ↔ session binding (state keyed per instance, never across agents);
 *   3. the turn lifecycle: one in-flight turn per conversation, steering mid-turn;
 *   4. delivery of the answer, and — the reason this file is so loud — proof that delivery
 *      happened, or did not.
 *
 * The Feishu surface this mirrors also draws a live card and a reaction state machine. Email
 * has neither: there is no live surface to patch and no message to react to, so all of the
 * beat/render/emoji machinery is deliberately absent rather than stubbed.
 *
 * Failure visibility is the design constraint that shapes the logging: the DSH logger's
 * output does not reach this service's stdout, so `<cwd>/logs/ses-mail.log` is the only
 * record of what the mailbox delivered, what was refused and why, and what SES said when a
 * send failed. A composed answer that never left is written there AND kept on disk.
 */
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { foldEvent, formatDuration, initialTurn } from './turn.js'
import { logPathFor, normaliseAddress, ownAddresses, pollIntervalMs } from './config.js'
import { SeenSet } from './dedup.js'
import { answerBody, buildReply, parseMail, userText, authSummary, senderAuthenticated } from './mail.js'
import { retryableSendError } from './ses.js'

/** One retry past a transient SES failure; more than that belongs to a human. */
const SEND_ATTEMPTS = 2
/** Pause before that retry. Long enough for a throttle to clear, short enough to be invisible. */
const SEND_RETRY_MS = 2_000

export class MailBot {
  constructor({ ctx, config, mailbox, store, logger, info = {} }) {
    this.ctx = ctx
    this.config = config
    this.mailbox = mailbox
    this.store = store
    this.logger = logger
    this.info = info // { cwd, instance }
    this.installChannelEffort()
    /** correspondent → per-correspondent binding + live turn (or `*` when sessionId is pinned) */
    this.conversations = new Map()
    this.seen = new SeenSet({ ttlMs: config.dedupTtlMs, maxEntries: config.seenMaxEntries })
    this.pollTimer = undefined
    this.disposed = false
    this.queue = Promise.resolve()
  }

  /** Serialize every inbound/outbound operation in event order. */
  chain(op) {
    const run = this.queue.then(op, op)
    this.queue = run.catch(() => undefined)
    return run
  }

  now() {
    return Date.now()
  }

  stamp() {
    return new Date().toISOString()
  }

  // ------------------------------------------------------------- lifecycle --

  async start() {
    for (const [key, saved] of Object.entries(this.store.get().conversations ?? {})) {
      this.conversations.set(key, { ...this.blankConversation(), sessionId: saved.sessionId })
    }
    this.seen.load(this.store.get().seen ?? {})
    this.appendLog(
      `${this.stamp()} ARMED instance=${this.info.instance} bucket=${this.config.mailBucket} prefix=${this.config.mailPrefix} ` +
      `allowlist=${this.allowlistOpen() ? 'OPEN' : this.config.operators.join(',')} seen=${this.seen.size}`,
    )
    const interval = pollIntervalMs(this.config)
    this.pollTimer = setInterval(() => this.tick(), interval)
    this.pollTimer.unref?.()
    this.logger.info?.(
      `ses-mini: armed as ${this.info.instance} (cwd ${this.info.cwd}, every ${Math.round(interval / 1000)}s, ` +
      `${this.config.mailBucket}/${this.config.mailPrefix})`,
    )
    // One poll at arm time: mail that arrived while the service was down is answered on the
    // first tick rather than after a full interval.
    this.tick()
  }

  /**
   * One scheduled poll, and never two at once.
   *
   * The chain already serializes, so overlapping polls could not interleave — but they WOULD
   * queue, and a slow bucket would then build a backlog of ticks that keeps the surface busy
   * long after S3 recovers while the log shows nothing wrong. Skipping a tick is recorded, so
   * "the channel is slow" is visible rather than inferred.
   */
  tick() {
    if (this.polling === true) {
      this.appendLog(`${this.stamp()} POLL-SKIPPED the previous poll is still running`)
      return
    }
    this.polling = true
    void this.chain(() => this.pollOnce())
      .catch((error) => this.warn('poll', error))
      .finally(() => { this.polling = false })
  }

  dispose() {
    this.disposed = true
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer)
    this.pollTimer = undefined
  }

  warn(where, error) {
    const detail = error?.message === undefined ? String(error) : String(error.message)
    this.logger.warn?.(`ses-mini: ${where} failed: ${detail}`)
    // Also to the file. The DSH logger's output does not reach the service's stdout, so a
    // failure that is only logged there is a failure nobody will ever see.
    this.appendLog(`${this.stamp()} FAILED ${where}: ${detail.slice(0, 400)}`)
  }

  /** Append one line to the event log — the surface's only durable record. */
  appendLog(line) {
    try {
      const path = this.logFile()
      mkdirSync(dirname(path), { recursive: true })
      appendFileSync(path, `${line}\n`)
    } catch {
      // best effort: logging must never break a turn
    }
  }

  logFile() {
    if (this.logFilePath === undefined) this.logFilePath = logPathFor(this.config, this.info.cwd || '.', join)
    return this.logFilePath
  }

  allowlistOpen() {
    return !Array.isArray(this.config.operators) || this.config.operators.length === 0
  }

  /**
   * Keep a raw answer that SES refused, so the work is not lost with the error message.
   *
   * This is the one deliverable of a failed send: the composed reply, byte for byte, in a
   * file an operator can hand to `aws ses send-raw-email`. A log line alone says "it failed";
   * the file is what makes it recoverable.
   */
  keepUndelivered(raw, detail) {
    try {
      const dir = join(this.info.cwd || '.', 'logs', 'undelivered')
      mkdirSync(dir, { recursive: true })
      const path = join(dir, `${this.stamp().replace(/[:.]/g, '-')}-${Math.random().toString(36).slice(2, 6)}.eml`)
      writeFileSync(path, raw, { mode: 0o600 })
      return path
    } catch (error) {
      this.appendLog(`${this.stamp()} UNDELIVERED-KEEP-FAILED ${String(detail).slice(0, 120)} — ${error?.message ?? error}`)
      return undefined
    }
  }

  // ------------------------------------------------------------- bindings --

  blankConversation() {
    return {
      sessionId: undefined,
      turn: initialTurn(),
      /** The inbound message this turn's answer must be threaded under. */
      replyTarget: undefined,
      /** Set before the send, so a re-emitted `turn/end` cannot mail a second answer. */
      answerSent: false,
      lastInboundAt: undefined,
    }
  }

  /**
   * The binding key for an address.
   *
   * Normally the correspondent: one person, one session, one in-flight turn — the email
   * equivalent of the Feishu surface's chat. With `sessionId` pinned the whole surface is ONE
   * conversation, keyed `*`, because two keys pointing at one session would make
   * `findBySession` ambiguous and could thread an answer to the wrong person.
   */
  conversationKey(address) {
    return this.config.sessionId === '' ? address : '*'
  }

  conversation(address) {
    const key = this.conversationKey(address)
    let entry = this.conversations.get(key)
    if (entry === undefined) {
      entry = { ...this.blankConversation(), sessionId: this.sessionIdFor(address) }
      this.conversations.set(key, entry)
      // First contact: record the binding so a restart resumes the same session (and so the
      // instance's state file shows which correspondents it serves).
      this.persist()
    }
    return entry
  }

  sessionIdFor(address) {
    if (this.config.sessionId !== '') return this.config.sessionId
    // Readable rather than hashed, because a session id ends up in logs and in a session
    // list: the domain is kept so two correspondents with the same local part stay distinct.
    const slug = normaliseAddress(address).replace(/@/g, '-').replace(/[^a-z0-9.-]/g, '').slice(0, 64)
    return `sm-${this.info.instance}-${slug === '' ? 'unknown' : slug}`
  }

  persist() {
    const conversations = {}
    for (const [key, entry] of this.conversations) {
      if (entry.sessionId !== undefined) conversations[key] = { sessionId: entry.sessionId }
    }
    this.store.update({ conversations, seen: this.seen.entries() })
  }

  findBySession(sessionId) {
    for (const entry of this.conversations.values()) {
      if (entry.sessionId === sessionId) return entry
    }
    return undefined
  }

  // ---------------------------------------------------------------- inbound --

  /**
   * One poll: list, skip what is already known, hand the rest to {@link handleObject}.
   *
   * Two bounds keep a backlog from becoming an incident: at most `maxPerPoll` objects are
   * processed per tick (a burst of mail must not spawn a burst of turns against one session),
   * and an object older than the dedup TTL is left alone — past that point the seen set has
   * forgotten its identity and the message would be answered as if it were new.
   */
  async pollOnce() {
    if (this.disposed) return
    let objects
    try {
      objects = await this.mailbox.list()
    } catch (error) {
      this.warn('s3 list', error)
      return
    }
    const now = this.now()
    const max = Number.isFinite(this.config.maxPerPoll) && this.config.maxPerPoll > 0 ? this.config.maxPerPoll : 10
    let processed = 0
    let deferred = 0
    let dirty = false
    for (const object of objects) {
      if (this.disposed) return
      if (this.seen.has(`obj:${object.key}`)) continue
      const age = now - object.lastModified.getTime()
      if (age > this.config.dedupTtlMs) {
        this.appendLog(`${this.stamp()} STALE key=${object.key} age=${Math.round(age / 3_600_000)}h — older than dedupTtlMs, left alone`)
        this.seen.add(`obj:${object.key}`)
        dirty = true
        continue
      }
      if (processed >= max) {
        deferred += 1
        continue
      }
      processed += 1
      await this.handleObject(object)
    }
    if (deferred > 0) {
      this.appendLog(`${this.stamp()} BACKLOG ${deferred} object(s) deferred to the next poll (maxPerPoll=${max})`)
    }
    if (dirty) this.persist()
  }

  /** Fetch, parse and act on one S3 object. */
  async handleObject(object) {
    if (object.size > this.config.maxMessageBytes) {
      this.refuse(`too large (${object.size} bytes > maxMessageBytes)`, { key: object.key, identity: `s3:${object.key}`, from: '', subject: '' })
      return
    }
    let raw
    try {
      raw = await this.mailbox.fetch(object.key)
    } catch (error) {
      // Deliberately not marked seen: a transient S3 failure must not lose the message.
      this.warn(`s3 get ${object.key}`, error)
      return
    }
    if (raw.length === 0) {
      this.refuse('empty object', { key: object.key, identity: `s3:${object.key}`, from: '', subject: '' })
      return
    }
    let mail
    try {
      mail = await parseMail(raw, { key: object.key, maxBodyChars: this.config.maxBodyChars })
    } catch (error) {
      // Marked seen: bytes that do not parse will never parse, and retrying them every poll
      // would hide the failure in a loop.
      this.warn(`parse ${object.key}`, error)
      this.refuse(`unparsable MIME (${error?.message ?? error})`, { key: object.key, identity: `s3:${object.key}`, from: '', subject: '' })
      return
    }
    await this.onMail(mail)
  }

  /**
   * Policy, then dispatch — the email equivalent of `HouseBot.onMessage`.
   *
   * Order matters. Dedup first, so a redelivery is dropped before anything is logged twice;
   * then the loop guards, because they are what make an accidental answer impossible; then
   * the allowlist; then content.
   */
  async onMail(mail) {
    if (this.disposed) return
    const identity = `msg:${mail.identity}`
    if (this.seen.has(identity)) {
      this.appendLog(`${this.stamp()} REFUSED reason=duplicate msg=${mail.identity} key=${mail.key} (already answered)`)
      this.seen.add(`obj:${mail.key}`)
      this.persist()
      return
    }

    this.appendLog(
      `${this.stamp()} INBOUND key=${mail.key} msg=${mail.identity} from=${mail.from === '' ? '?' : mail.from} ` +
      `subject="${mail.subject.slice(0, 80)}" date=${mail.date.toISOString()} chars=${mail.body.length} raw-chars=${mail.plain.length} ` +
      authSummary(mail.auth) +
      `${mail.inline ? ' inline-reply=yes' : ''}${mail.identitySource === 's3' ? ' no-message-id=yes' : ''}`,
    )

    const reason = this.refusalReason(mail)
    if (reason !== undefined) {
      this.refuse(reason, mail)
      return
    }

    const entry = this.conversation(mail.from)
    // Last accepted mail of the turn is what the answer is threaded under: a mid-turn
    // steering message is the request the owner is looking at, and replying under it keeps
    // the answer in the thread they can see.
    entry.replyTarget = mail
    entry.lastInboundAt = this.now()

    const agent = await this.ensureAgent(entry)
    if (agent === undefined) {
      // Not a refusal: nothing about this message is wrong, the composition is. It is left
      // UNSEEN so the next poll tries again — losing a real message to a temporarily missing
      // service would be exactly the silent failure this channel must not have.
      this.appendLog(`${this.stamp()} UNAVAILABLE no agent service in this composition — ${mail.key} left for the next poll`)
      this.logger.warn?.('ses-mini: no agent service in this composition — mail is not being dispatched')
      return
    }
    const userMessage = createUserMessage({
      content: [{ type: 'text', text: userText(mail, this.config) }],
      source: { kind: 'user' },
    })
    const running = agent.status === 'running'
    if (running && this.config.steerMidTurn) {
      agent.steer(userMessage)
      this.appendLog(`${this.stamp()} STEER from=${mail.from} session=${entry.sessionId} (turn ${entry.turn.turn} was running)`)
    } else {
      agent.followup(userMessage)
      this.appendLog(`${this.stamp()} DISPATCH from=${mail.from} session=${entry.sessionId}${this.allowlistOpen() ? ' allowlist=OPEN' : ''}`)
    }
    // Marked seen only AFTER the dispatch: a crash in between costs a duplicate answer after
    // the restart, which the log shows, while marking first would cost a silently unanswered
    // message, which nothing shows.
    this.seen.add(identity)
    this.seen.add(`obj:${mail.key}`)
    this.persist()
  }

  /** Why this message must not start a turn, or `undefined` if it may. */
  refusalReason(mail) {
    if (mail.from === '') return 'no usable From address (nothing to answer)'
    if (ownAddresses(this.config).includes(mail.from)) return `own address (${mail.from}) — a mail loop`
    if (mail.automation !== undefined) return `automated: ${mail.automation}`
    if (!this.allowlistOpen()) {
      const allowed = this.config.operators.map((value) => normaliseAddress(value))
      if (!allowed.includes(mail.from)) return `not an operator (from=${mail.from})`
      // The allowlist matches a *header*. When the owner asks for it, that header must also be
      // backed by SES's verdict — otherwise an impersonator drives an agent with a shell.
      if (!senderAuthenticated(this.config.requireSenderAuth, mail.auth, mail.from)) {
        return `unauthenticated sender (want ${this.config.requireSenderAuth}; ${authSummary(mail.auth)})`
      }
    }
    if (mail.body.trim() === '') return 'empty body (no text part; attachments are not read)'
    return undefined
  }

  /**
   * Record a refusal and drop the message.
   *
   * Never answered, on purpose: replying to a stranger who mailed the address is backscatter,
   * and replying to an autoresponder or a list is how a mail loop starts. The refusal exists
   * in the log with its reason, which is what an operator needs; the sender gets silence,
   * which is what a mail server should do.
   */
  refuse(reason, mail) {
    const line =
      `${this.stamp()} REFUSED reason=${reason} from=${mail.from === '' ? '?' : mail.from} ` +
      `subject="${String(mail.subject ?? '').slice(0, 80)}" msg=${mail.identity} key=${mail.key}`
    this.appendLog(line)
    this.logger.warn?.(`ses-mini: ${line}`)
    if (typeof mail.identity === 'string') this.seen.add(`msg:${mail.identity}`)
    if (typeof mail.key === 'string' && mail.key !== '') this.seen.add(`obj:${mail.key}`)
    this.persist()
  }

  // ------------------------------------------------------------- host events --

  onSessionEvent(session, event) {
    if (this.disposed) return
    const entry = this.findBySession(String(session?.id ?? ''))
    if (entry === undefined) return
    foldEvent(entry.turn, event, this.now())
    void this.chain(async () => {
      if (event?.type === 'turn/start') {
        entry.answerSent = false
      } else if (event?.type === 'turn/end') {
        await this.finalizeTurn(entry)
      }
    }).catch((error) => this.warn('event', error))
  }

  async ensureAgent(entry) {
    const agents = this.ctx.get?.('agents')
    if (agents === undefined) return undefined
    const live = agents.get(entry.sessionId)
    const existing = live?.agent ?? live
    if (existing !== undefined && existing !== null) return existing
    const agentOptions = this.agentOptions()
    try {
      const resumed = await agents.resume({
        resumeSessionId: entry.sessionId,
        ...(agentOptions === undefined ? {} : { agentOptions }),
      })
      return resumed?.agent ?? resumed
    } catch {
      // no persisted session for this correspondent yet — fall through to create
    }
    const created = await agents.create({
      sessionId: entry.sessionId,
      meta: { cwd: this.info.cwd },
      ...(agentOptions === undefined ? {} : { agentOptions }),
    })
    return created?.agent ?? created
  }

  /**
   * Route for sessions this surface creates. Config first, then the host's default model
   * selection — without a route the created agent fails its first turn ("has no
   * provider/model"), and the mail that triggered it goes unanswered.
   */
  agentOptions() {
    let provider = this.config.provider === '' ? undefined : this.config.provider
    let model = this.config.model === '' ? undefined : this.config.model
    if (provider === undefined || model === undefined) {
      try {
        const selection = this.ctx.get?.('agentDefaultModel')?.currentSelection?.()
        if (provider === undefined && typeof selection?.provider === 'string') provider = selection.provider
        if (model === undefined && typeof selection?.model === 'string') model = selection.model
      } catch {
        // no default model service in this composition: keep whatever config gave us
      }
    }
    if (provider === undefined && model === undefined) return undefined
    return { ...(provider === undefined ? {} : { provider }), ...(model === undefined ? {} : { model }) }
  }

  /**
   * CHANNEL-CONTRACT §2: this channel's `reasoningEffort` is a persistent
   * per-surface override for sessions the surface owns. Profile-wide
   * middlewares (agent-default-model) strip inherited effort per request, so
   * the override re-applies it for our sessions after `next()` resolves.
   */
  installChannelEffort() {
    const effort = typeof this.config.reasoningEffort === 'string' ? this.config.reasoningEffort.trim() : ''
    if (effort === '') return
    this.ctx.on('agent/request', async (payload, next) => {
      const resolved = await next()
      const sid = String(payload?.agent?.session?.id ?? '')
      if (sid === '' || this.findBySession(sid) === undefined) return resolved
      return { ...resolved, reasoningEffort: effort }
    })
  }

  // ------------------------------------------------------------- outbound --

  /**
   * The answer: build the raw MIME and hand it to SES.
   *
   * Three things are load-bearing and each one is a way this channel fails silently:
   * `entry.answerSent` is set before the send so a re-emitted `turn/end` cannot mail twice; a
   * turn with no inbound to answer sends NOTHING (a turn driven by a cron job on the same
   * session must not mail the owner); and a failed send is reported with the provider's own
   * text, its raw message kept on disk, and never swallowed.
   */
  async finalizeTurn(entry) {
    const turn = entry.turn
    if (entry.answerSent === true) {
      this.appendLog(`${this.stamp()} ANSWER-SKIPPED session=${entry.sessionId} (this turn was already answered)`)
      return
    }
    const mail = entry.replyTarget
    if (mail === undefined) {
      this.appendLog(`${this.stamp()} ANSWER-SKIPPED session=${entry.sessionId} turn=${turn.turn} (ended with no inbound mail to answer)`)
      return
    }
    entry.answerSent = true
    entry.replyTarget = undefined

    const body = answerBody(turn, this.config)
    const reply = buildReply({ config: this.config, mail, body })
    const duration = turn.startedAt === undefined ? undefined : formatDuration(this.now() - turn.startedAt)
    this.appendLog(
      `${this.stamp()} TURN-END session=${entry.sessionId} turn=${turn.turn} phase=${turn.phase} ` +
      `rounds=${turn.rounds} tools=${turn.tools} model=${turn.model ?? '?'}${duration === undefined ? '' : ` in=${duration}`} ` +
      `chars=${body.length}`,
    )
    await this.sendReply({ reply, mail })
  }

  /** One send, with exactly one retry past a transient provider error. */
  async sendReply({ reply, mail }) {
    const thread = reply.headers['In-Reply-To']
    for (let attempt = 1; attempt <= SEND_ATTEMPTS; attempt += 1) {
      this.appendLog(
        `${this.stamp()} SEND ATTEMPT n=${attempt} to=${reply.to} from=${this.config.fromAddress} ` +
        `subject="${reply.subject.slice(0, 80)}" bytes=${reply.raw.length} in-reply-to=${thread ?? '-'} msg=${mail.identity}`,
      )
      try {
        const result = await this.mailbox.send({ raw: reply.raw, to: reply.to })
        this.appendLog(`${this.stamp()} SENT n=${attempt} to=${reply.to} id=${result?.messageId ?? '?'}`)
        this.logger.info?.(`ses-mini: answered ${reply.to} (${result?.messageId ?? 'no id'})`)
        return true
      } catch (error) {
        const detail = error?.message === undefined ? String(error) : String(error.message)
        const name = error?.name ?? 'Error'
        // The provider's own words, at full length in the file: "send failed" without SES's
        // text is the log line that turns a five-minute fix into an afternoon.
        this.appendLog(`${this.stamp()} SEND FAILED n=${attempt} to=${reply.to} error=${name}: ${detail.slice(0, 500)}`)
        this.logger.warn?.(`ses-mini: send failed (attempt ${attempt}/${SEND_ATTEMPTS}): ${name}: ${detail.slice(0, 300)}`)
        const last = attempt >= SEND_ATTEMPTS || !retryableSendError(error)
        if (last) {
          const path = this.keepUndelivered(reply.raw, detail)
          this.appendLog(
            `${this.stamp()} UNDELIVERED to=${reply.to} subject="${reply.subject.slice(0, 80)}"` +
            `${path === undefined ? ' (the composed message could not be kept on disk)' : ` kept at ${path}`}`,
          )
          return false
        }
        await new Promise((resolve) => setTimeout(resolve, SEND_RETRY_MS))
      }
    }
    return false
  }
}
