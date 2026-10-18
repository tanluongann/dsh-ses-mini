/**
 * Harness: drives the real mail/dedup/bot/transport code with fakes.
 * `node test/harness.mjs` — no network, no AWS, no DSH session.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync , writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { simpleParser } from 'mailparser'
import { Config, instanceOf, logPathFor, normaliseAddress, ownAddresses, pollIntervalMs } from '../lib/config.js'
import { SeenSet } from '../lib/dedup.js'
import { StateStore } from '../lib/state.js'
import { answerBody, authSummary, senderAuthenticated, automationReason, buildReply, clipBody, emptyAnswer, headerValue, parseMail, rawHeaders, replySubject, splitQuote, threadOf, userText } from '../lib/mail.js'
import { createMailbox, readBody, retryableSendError } from '../lib/ses.js'
import { foldEvent, initialTurn, textOf } from '../lib/turn.js'
import { MailBot } from '../lib/bot.js'
import { OutboundPipe } from '../lib/outbound.js'

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))

/** The config every section starts from: one allowed correspondent, one From address. */
const baseConfig = (overrides = {}) => Config({
  mailBucket: 'nelly-mail', mailPrefix: 'inbound/', fromAddress: 'nelly@tiaolabs.com', fromName: 'Nelly',
  operators: ['mathieu@example.com'], provider: 'deepseek-official', model: 'deepseek-flash', ...overrides,
})

// ------------------------------------------------------------------ config --
{
  const config = Config({ mailBucket: 'b', fromAddress: 'nelly@tiaolabs.com' })
  assert.equal(config.mode, 'on')
  assert.equal(config.mailPrefix, 'inbound/')
  assert.equal(config.pollMs, 30_000)
  assert.equal(config.dedupTtlMs, 14 * 24 * 60 * 60_000)
  assert.equal(config.maxBodyChars, 20_000)
  assert.deepEqual(config.operators, [])
  assert.equal(config.steerMidTurn, true, 'auto-steer is the default')
  assert.equal(config.includeQuotedOriginal, false, 'no quoted history by default')
  assert.equal(config.sessionId, '', 'per-correspondent sessions by default')
  assert.equal(Config({ mailBucket: 'b', fromAddress: 'a@b' }).maxPerPoll, 10)

  assert.equal(normaliseAddress('Mathieu <M@Example.COM>'), 'm@example.com')
  assert.equal(normaliseAddress('<a@b>'), 'a@b')
  assert.equal(normaliseAddress('bare@b'), 'bare@b')
  assert.equal(normaliseAddress(''), '')
  assert.deepEqual(ownAddresses({ fromAddress: 'Nelly <n@tiaolabs.com>', replyTo: 'n@tiaolabs.com' }), ['n@tiaolabs.com'], 'own addresses are deduped and normalised')

  assert.equal(pollIntervalMs({ pollMs: 0 }), 30_000, 'a zero poll interval cannot spin the loop')
  assert.equal(pollIntervalMs({ pollMs: 5_000 }), 5_000)
  assert.equal(instanceOf({ fromAddress: 'nelly@tiaolabs.com' }), 'mail-nelly')
  assert.equal(instanceOf({ fromAddress: 'nelly@tiaolabs.com', instance: 'wine' }), 'wine')
  assert.match(logPathFor({ logPath: '' }, '/w', join), /\/w\/logs\/ses-mail\.log$/)
  assert.equal(logPathFor({ logPath: 'logs/x.log' }, '/w', join), '/w/logs/x.log')
  ok('config defaults, address normalisation, instance + log-path resolution')
}

// ------------------------------------------------------------ header guards --
{
  const raw = fixture('auto-reply.eml')
  const mail = await parseMail(raw, { key: 'k' })
  assert.equal(mail.from, 'mathieu@example.com', 'the From address is normalised')
  assert.equal(mail.fromName, 'Mathieu D')
  assert.equal(mail.subject, 'Réponse automatique : Cave order', 'RFC 2047 subjects are decoded')
  assert.equal(mail.automation, 'auto-submitted: auto-replied', 'RFC 3834 wins the reason')
  assert.equal(mail.date.toISOString(), '2026-10-14T09:06:00.000Z')
  assert.deepEqual(mail.references, ['<plain-0001@example.com>', '<answer-0001@tiaolabs.com>'])
  assert.equal(mail.inReplyTo, '<answer-0001@tiaolabs.com>')
  assert.equal(mail.identity, '<autoreply-0005@example.com>')

  // List-Id is the trap: mailparser moves it to a `list` key, so a guard written against the
  // parsed map stops guarding. Ours reads the raw header lines.
  const bulk = await parseMail(fixture('bulk.eml'), { key: 'k' })
  assert.equal(bulk.automation, 'precedence: bulk')
  const bulkHeaders = rawHeaders(await simpleParser(fixture('bulk.eml')))
  assert.equal(headerValue(bulkHeaders, 'list-id'), 'Wine Weekly <wine.lists.example.net>', 'the raw header is visible')

  const bounce = await parseMail(fixture('bounce.eml'), { key: 'k' })
  assert.equal(bounce.automation, 'null return path (bounce)', 'a bounce has no mailbox to answer')

  // Every guard on its own, without needing a fixture per header.
  const withHeader = (lines) => rawHeaders({ headerLines: lines.map((line) => ({ key: line.slice(0, line.indexOf(':')).toLowerCase(), line })) })
  assert.equal(automationReason(withHeader(['List-Unsubscribe: <mailto:x@y>'])), 'list-unsubscribe: <mailto:x@y>')
  assert.equal(automationReason(withHeader(['X-Autoreply: yes'])), 'x-autoreply: yes')
  assert.equal(automationReason(withHeader(['X-Auto-Response-Suppress: All'])), 'x-auto-response-suppress: All')
  assert.equal(automationReason(withHeader(['Precedence: junk'])), 'precedence: junk')
  assert.equal(automationReason(withHeader(['Auto-Submitted: no']), 'hello'), undefined, '`no` is the one value a human sends')
  assert.equal(automationReason(withHeader([]), 'Réponse automatique : Cave'), 'subject looks automated: réponse automatique : cave', 'a mailer that sets no header is caught by its subject')
  assert.equal(automationReason(withHeader([]), 'Question about the 2019 vintage'), undefined)
  assert.equal(automationReason(withHeader([]), 'Automatic reply: your order'), 'subject looks automated: automatic reply: your order')

  const folded = await parseMail(fixture('no-message-id.eml'), { key: 'inbound/x' })
  assert.equal(folded.subject, 'Re: dossier imported', 'a folded subject is unfolded')
  assert.equal(folded.messageId, undefined)
  assert.equal(folded.identity, 's3:inbound/x', 'without a Message-ID the object key is the identity')
  assert.equal(folded.identitySource, 's3')
  ok('guards: auto-submitted, precedence, list, autoresponder, bounce, subject fallback, folded headers')
}

// ------------------------------------------------------------- body handling --
{
  const multi = await parseMail(fixture('multipart-alternative.eml'), { key: 'k' })
  assert.match(multi.body, /dégustation était très belle/, 'the text/plain part is what the model sees')
  assert.equal(multi.body.includes('HTML should never'), false, 'the html alternative does not leak in')

  const quoted = await parseMail(fixture('quoted-reply.eml'), { key: 'k' })
  assert.equal(quoted.body, 'Deux caisses alors, pas trois.', 'the history is not handed to the model')
  assert.equal(quoted.plain.includes('Trois caisses sont disponibles'), true, 'but it is still there in the untouched text')
  assert.equal(quoted.inline, false)

  // The risky direction: a bottom-posted reply answers UNDER the quote, and cutting there
  // would silently drop the human's words.
  const bottom = splitQuote('On Mon, 13 Oct 2026 at 10:00, nelly@tiaolabs.com wrote:\n> Three crates?\n\nDeux, pas trois.\nMerci.')
  assert.equal(bottom.inline, true, 'a bottom-posted reply is detected')
  assert.match(bottom.body, /Deux, pas trois\./, 'and nothing is stripped from it')

  const inlineReply = splitQuote('> what time?\n14:00\n\n> where?\nhome')
  assert.equal(inlineReply.quote, '', 'an inline reply has no trailing quoted run to cut')

  assert.equal(splitQuote('Sans citation du tout.').body, 'Sans citation du tout.')
  const outlook = splitQuote('Short answer.\n\n________________________________\nFrom: Nelly\nSent: Monday\n\n> old text')
  assert.equal(outlook.body, 'Short answer.', 'the Outlook separator is a cut point')
  const trailing = splitQuote('my answer\n\n> quoted a\n> quoted b')
  assert.equal(trailing.body, 'my answer')
  assert.equal(trailing.quote, '> quoted a\n> quoted b')
  assert.equal(splitQuote('> only a quote').body, '> only a quote', 'a message that is nothing but a quote is not emptied')

  assert.equal(clipBody('abcdef', 3), 'abcdef\n\n[truncated: 3 more characters not shown]'.replace('abcdef\n\n', 'abc\n\n'))
  assert.match(clipBody('x'.repeat(100), 10), /^x{10}\n\n\[truncated: 90 more characters not shown\]$/)
  assert.equal(replySubject('Cave order'), 'Re: Cave order')
  assert.equal(replySubject('Re: Cave order'), 'Re: Cave order', 'never doubled')
  assert.equal(replySubject('RE: cave'), 'RE: cave')
  assert.equal(replySubject(''), 'Re: (no subject)')
  assert.equal(replySubject('a\nb'), 'Re: a b', 'a newline in a subject cannot survive')
  ok('bodies: alternatives, top-posted vs bottom-posted quotes, clipping, Re: subjects')
}

// --------------------------------------------------------------- the answer --
{
  const mail = await parseMail(fixture('quoted-reply.eml'), { key: 'k' })
  const config = baseConfig({ signature: 'Nelly\nDomaine Tiaolabs' })
  const reply = buildReply({ config, mail, body: 'Deux caisses, confirmé.', now: new Date('2026-10-14T12:00:00Z') })

  assert.equal(reply.to, 'mathieu@example.com', 'the answer goes to the sender')
  assert.equal(reply.subject, 'Re: Cave order')
  assert.equal(reply.headers['In-Reply-To'], '<quoted-0003@example.com>', 'the message we answer')
  assert.equal(reply.headers.References, '<plain-0001@example.com> <answer-0001@tiaolabs.com> <quoted-0003@example.com>', 'the whole chain, root first: that is what lands the reply in the original conversation')
  assert.equal(reply.headers['Auto-Submitted'], 'auto-replied', 'our own output is marked, so a loop back into the mailbox is refused by one header')
  assert.match(reply.headers['Message-ID'], /^<sm-[-0-9a-f]{36}@tiaolabs\.com>$/, 'a reply needs its own id, in our domain')
  assert.equal(reply.headers.From, 'Nelly <nelly@tiaolabs.com>')
  assert.equal(reply.headers.To, 'Mathieu D <mathieu@example.com>')

  // Round trip: what SES would transmit, parsed back by an independent parser.
  const parsed = await simpleParser(reply.raw)
  assert.equal(parsed.subject, 'Re: Cave order')
  assert.equal(parsed.to.value[0].address, 'mathieu@example.com')
  assert.equal(parsed.from.value[0].name, 'Nelly')
  assert.equal(parsed.inReplyTo, '<quoted-0003@example.com>')
  assert.equal(headerValue(rawHeaders(parsed), 'in-reply-to'), '<quoted-0003@example.com>')
  assert.deepEqual(parsed.references, ['<plain-0001@example.com>', '<answer-0001@tiaolabs.com>', '<quoted-0003@example.com>'], 'the folded chain survives the round trip whole')
  assert.equal(parsed.text, 'Deux caisses, confirmé.\n\n-- \nNelly\nDomaine Tiaolabs', 'the signature rides under the RFC 3676 delimiter')
  assert.equal(reply.raw.toString('utf8').includes('Content-Transfer-Encoding: base64'), true, 'the body is base64: model output has no line-length discipline')
  for (const line of reply.raw.toString('utf8').split('\r\n')) {
    assert.ok(line.length <= 998, `every line stays inside the SMTP limit (saw ${line.length})`)
  }

  // Non-ASCII goes out as an encoded word, and the quoted original is opt-in.
  const nonAscii = buildReply({ config: baseConfig({ includeQuotedOriginal: true, quoteChars: 40 }), mail: { ...mail, subject: 'Dégustation' }, body: 'Parfait.' })
  assert.match(nonAscii.headers.Subject, /^=\?UTF-8\?B\?/, 'a non-ASCII subject is encoded, not mangled')
  assert.equal((await simpleParser(nonAscii.raw)).subject, 'Re: Dégustation')
  const quotedBody = (await simpleParser(nonAscii.raw)).text
  assert.match(quotedBody, /wrote:\n> Deux caisses alors/, 'the original is quoted under the answer')
  assert.ok(quotedBody.length < 400, `quoteChars bounds the excerpt (saw ${quotedBody.length})`)
  assert.equal(buildReply({ config: baseConfig(), mail, body: 'x' }).raw.toString('utf8').includes('wrote:'), false)

  // Header injection, the realistic way it happens: an RFC 2047 encoded word that DECODES to
  // a CRLF. The decoded value is what we echo into the reply's Subject, so this is where a
  // mail header would grow a second header — and where a `Bcc:` would come from.
  const evil = `=?UTF-8?B?${Buffer.from('Cave\r\nBcc: attacker@example.com').toString('base64')}?=`
  const evilRaw = Buffer.from(`From: "A B" <mathieu@example.com>\r\nSubject: ${evil}\r\nMessage-ID: <i@e>\r\n\r\nhello`)
  assert.equal((await simpleParser(evilRaw)).subject.includes('\n'), true, 'the decoded subject really does carry a newline')
  const injected = await parseMail(evilRaw, { key: 'k' })
  assert.equal(injected.subject.includes('\n'), false, 'parse flattens it to one line')
  const injectedReply = buildReply({ config: baseConfig(), mail: injected, body: 'ok' })
  const rawText = injectedReply.raw.toString('utf8')
  const headerBlock = rawText.split('\r\n\r\n')[0]
  const names = headerBlock.split('\r\n').filter((line) => !/^\s/.test(line)).map((line) => line.slice(0, line.indexOf(':')))
  assert.deepEqual(
    names,
    ['From', 'To', 'Subject', 'Date', 'Message-ID', 'In-Reply-To', 'References', 'Auto-Submitted', 'MIME-Version', 'Content-Type', 'Content-Transfer-Encoding'],
    'the payload cannot grow a header of its own',
  )
  assert.equal(rawText.includes('\r\nBcc:'), false, 'and a smuggled Bcc: never starts a line')
  const roundTripped = await simpleParser(injectedReply.raw)
  assert.equal(roundTripped.bcc, undefined)
  assert.match(roundTripped.subject, /Cave Bcc: attacker@example\.com/, 'the payload survives as inert text')
  assert.equal(roundTripped.to.value[0].name, 'A B')

  assert.equal(String(buildReply({ config: baseConfig({ replyTo: 'hello@tiaolabs.com' }), mail, body: 'x' }).headers['Reply-To']), 'hello@tiaolabs.com')
  assert.equal(buildReply({ config: baseConfig(), mail, body: 'x' }).headers['Reply-To'], undefined)

  const noParent = buildReply({ config: baseConfig(), mail: { from: 'a@b', fromName: '', subject: 's', date: new Date(), messageId: undefined, references: [], inReplyTo: undefined }, body: 'x' })
  assert.equal(noParent.headers['In-Reply-To'], undefined, 'nothing to thread under: the headers are omitted, not faked')

  const user = userText(mail, baseConfig())
  assert.match(user, /^\[email from Mathieu D <mathieu@example.com> · subject "Re: Cave order"/)
  assert.match(user, /do not send mail yourself/, 'the envelope tells the model what the channel does with its answer')
  assert.match(user, /Deux caisses alors, pas trois\.$/, 'and carries the text the human wrote')

  assert.match(answerBody(initialTurn(), baseConfig()), /no answer text was produced this turn/)
  const failed = { ...initialTurn(), lastText: 'partial answer', endReason: { kind: 'error', error: { message: 'provider 500' } } }
  assert.match(answerBody(failed, baseConfig()), /partial answer\n\n\[this turn ended with an error: provider 500\]/)
  assert.match(emptyAnswer({ ...initialTurn(), endReason: { kind: 'aborted' } }), /ended: aborted/)
  assert.equal(answerBody({ ...initialTurn(), lastText: 'clean' }, baseConfig()), 'clean', 'a clean turn carries no note')

  assert.equal(threadOf({ messageId: '<x@y>', references: [], inReplyTo: '<x@y>' }).references.join(' '), '<x@y>', 'no duplicate ids in the chain')
  ok('answer: threading headers, base64 body, signature, quoting, header-injection defence')
}

// -------------------------------------------------------------------- dedup --
{
  let now = 1_000_000
  const seen = new SeenSet({ ttlMs: 1_000, maxEntries: 3, now: () => now })
  assert.equal(seen.add('msg:a'), true, 'first sighting is new')
  assert.equal(seen.add('msg:a'), false, 'second sighting is not')
  assert.equal(seen.has('msg:a'), true)
  now += 1_500
  assert.equal(seen.has('msg:a'), false, 'past the TTL it is forgotten')

  const capped = new SeenSet({ ttlMs: 10_000, maxEntries: 2, now: () => now })
  capped.add('a'); now += 1; capped.add('b'); now += 1; capped.add('c')
  assert.equal(capped.size, 2, 'the cap holds')
  assert.equal(capped.has('a'), false, 'the oldest entry is the one evicted')
  assert.equal(capped.has('c'), true)

  // Persistence is the whole point: a restart must not answer the same mail twice.
  const reloaded = new SeenSet({ ttlMs: 10_000, maxEntries: 2, now: () => now }).load(capped.entries())
  assert.equal(reloaded.has('c'), true)
  const expired = new SeenSet({ ttlMs: 10, now: () => now }).load({ 'msg:old': now - 1_000 })
  assert.equal(expired.size, 0, 'an expired persisted entry is dropped at load, not replayed')
  assert.equal(new SeenSet({ ttlMs: 10, now: () => now }).load({ 'msg:old': 'not-a-number' }).size, 0, 'a corrupt entry cannot poison the set')
  ok('dedup: TTL, size cap with oldest-first eviction, persistence across a restart')
}

// ------------------------------------------------------------------- state --
{
  const dir = mkdtempSync(join(tmpdir(), 'sm-state-'))
  const store = new StateStore(dir, 'mail-nelly')
  store.load()
  store.update({ conversations: { 'mathieu@example.com': { sessionId: 'sm-mail-nelly-mathieu-example.com' } }, seen: { 'msg:a': 1 } })
  assert.match(store.path, /ses-mini-mail-nelly\.json$/, 'state is namespaced per instance')
  const reread = new StateStore(dir, 'mail-nelly')
  reread.load()
  assert.equal(reread.get().conversations['mathieu@example.com'].sessionId, 'sm-mail-nelly-mathieu-example.com')
  assert.equal(reread.get().seen['msg:a'], 1)
  const other = new StateStore(dir, 'mail-shared')
  other.load()
  assert.equal(Object.keys(other.get().conversations).length, 0, 'another instance cannot see this binding')
  rmSync(dir, { recursive: true, force: true })
  ok('state: per-instance file, round trip, isolation')
}

// ------------------------------------------------------------------ the bot --
function fakeMailbox() {
  const calls = { listed: 0, fetched: [], sent: [] }
  /** key → { raw, at } */
  const objects = new Map()
  return {
    calls,
    objects,
    put(key, raw, at = new Date()) { objects.set(key, { raw, at }); return key },
    async list() {
      calls.listed += 1
      return [...objects.entries()].map(([key, value]) => ({ key, lastModified: value.at, size: value.raw.length }))
    },
    async fetch(key) { calls.fetched.push(key); return objects.get(key).raw },
    async send({ raw, to }) { calls.sent.push({ raw, to }); return { messageId: `0100${calls.sent.length}` } },
  }
}

function fakeAgent() {
  const seen = { followup: [], steer: [], cancel: [] }
  return {
    seen,
    status: 'idle',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    followup(message) { seen.followup.push(message); this.status = 'running' },
    steer(message) { seen.steer.push(message) },
    cancel(cause, options) { seen.cancel.push({ cause, options }); this.status = 'idle' },
  }
}

function fakeCtx(agent) {
  const handlers = {}
  return {
    handlers,
    logger: { info: () => {}, warn: () => {} },
    profileContext: { dir: '/tmp', cwd: '/tmp' },
    get(name) {
      if (name !== 'agents') return undefined
      return { get: () => agent, resume: async () => { throw new Error('no session') }, create: async () => ({ agent }) }
    },
    on(name, handler) { handlers[name] = handler; return () => { delete handlers[name] } },
  }
}

/** A started bot with fakes, a temp state dir and a workspace for the log file. */
async function botHarness(overrides = {}, { agent = fakeAgent(), warn } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'sm-bot-'))
  const workdir = mkdtempSync(join(tmpdir(), 'sm-work-'))
  const config = baseConfig({ cwd: workdir, pollMs: 3_600_000, ...overrides })
  const mailbox = fakeMailbox()
  const ctx = fakeCtx(agent)
  if (warn !== undefined) ctx.logger = { info: () => {}, warn }
  const store = new StateStore(dir, instanceOf(config))
  store.load()
  const bot = new MailBot({ ctx, config, mailbox, store, logger: ctx.logger, info: { instance: instanceOf(config), cwd: workdir } })
  await bot.start()
  await bot.chain(() => Promise.resolve())
  ctx.on('session/event', (session, event) => bot.onSessionEvent(session, event))
  return {
    bot, mailbox, ctx, agent, config, store, dir, workdir,
    settle: () => bot.chain(() => Promise.resolve()),
    log: () => readFileSync(bot.logFile(), 'utf8'),
    sessionId: () => [...bot.conversations.values()][0]?.sessionId,
    close: () => { bot.dispose(); rmSync(dir, { recursive: true, force: true }); rmSync(workdir, { recursive: true, force: true }) },
  }
}

{
  const h = await botHarness()
  const { bot, mailbox, agent, ctx } = h

  // 1. a delivered mail becomes a turn, and the arm-time poll answers mail that arrived
  //    while the service was down without waiting for the first interval.
  mailbox.put('inbound/0001', fixture('plain.eml'))
  await bot.chain(() => bot.pollOnce())
  await h.settle()
  assert.equal(agent.seen.followup.length, 1, 'one mail, one turn')
  assert.equal(agent.seen.steer.length, 0)
  assert.match(agent.seen.followup[0].content[0].text, /Peux-tu confirmer la commande de mardi/)
  assert.match(h.log(), /INBOUND key=inbound\/0001 msg=<plain-0001@example\.com> from=mathieu@example\.com/)
  assert.match(h.log(), /DISPATCH from=mathieu@example\.com session=sm-mail-nelly-mathieu-example.com/)
  assert.equal(bot.conversations.get('mathieu@example.com').sessionId, 'sm-mail-nelly-mathieu-example.com', 'the session is derived from the instance and the correspondent')

  // 2. the turn's answer is emailed back, threaded under the mail that started it
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'turn/start', data: { turn: 1 } })
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Oui, trois caisses pour mardi.' }] } } })
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.settle()
  assert.equal(mailbox.calls.sent.length, 1, 'exactly one answer')
  const answer = await simpleParser(mailbox.calls.sent[0].raw)
  assert.equal(mailbox.calls.sent[0].to, 'mathieu@example.com')
  assert.equal(answer.subject, 'Re: Cave order')
  assert.equal(answer.to.value[0].address, 'mathieu@example.com')
  assert.equal(answer.inReplyTo, '<plain-0001@example.com>')
  assert.equal(answer.text, 'Oui, trois caisses pour mardi.')
  assert.match(h.log(), /SEND ATTEMPT n=1 to=mathieu@example\.com/)
  assert.match(h.log(), /SENT n=1 to=mathieu@example\.com id=01001/)

  // 3. a re-emitted turn/end must not mail a second answer
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.settle()
  assert.equal(mailbox.calls.sent.length, 1, 'the same turn cannot be answered twice')
  assert.match(h.log(), /ANSWER-SKIPPED .*already answered/)

  // 4. a mail that arrives while a turn runs is steered into it, and the one answer that
  //    follows comes back under the mail the owner just sent
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'turn/start', data: { turn: 2 } })
  await h.settle()
  agent.status = 'running'
  mailbox.put('inbound/0002', fixture('quoted-reply.eml'))
  await bot.chain(() => bot.pollOnce())
  await h.settle()
  assert.equal(agent.seen.steer.length, 1, 'steered into the running turn')
  assert.equal(agent.seen.followup.length, 1, '…and not queued as a new turn')
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Deux, entendu.' }] } } })
  ctx.handlers['session/event']({ id: h.sessionId() }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  await h.settle()
  assert.equal(mailbox.calls.sent.length, 2, 'one answer for the steered turn, not one per message')
  const steered = await simpleParser(mailbox.calls.sent[1].raw)
  assert.equal(steered.inReplyTo, '<quoted-0003@example.com>', 'threaded under the newest mail')
  assert.deepEqual(steered.references, ['<plain-0001@example.com>', '<answer-0001@tiaolabs.com>', '<quoted-0003@example.com>'])
  assert.match(h.log(), /STEER from=mathieu@example\.com session=/)
  h.close()
  ok('bot: inbound → turn, threaded answer, one answer per turn, mid-turn steering')
}

{
  // Refusals: every one is recorded WITH its reason, and none of them is answered.
  const warns = []
  const h = await botHarness({}, { warn: (line) => warns.push(String(line)) })
  const { bot, mailbox, agent } = h
  mailbox.put('inbound/a', fixture('not-allowed.eml'))
  mailbox.put('inbound/b', fixture('auto-reply.eml'))
  mailbox.put('inbound/c', fixture('bulk.eml'))
  mailbox.put('inbound/d', fixture('bounce.eml'))
  mailbox.put('inbound/e', fixture('self.eml'))
  await bot.chain(() => bot.pollOnce())
  await h.settle()
  assert.equal(agent.seen.followup.length, 0, 'nothing refused reaches the agent')
  assert.equal(mailbox.calls.sent.length, 0, 'and nothing refused is answered (no backscatter, no loop)')
  const log = h.log()
  assert.match(log, /REFUSED reason=not an operator \(from=stranger@example\.net\)/)
  assert.match(log, /REFUSED reason=automated: auto-submitted: auto-replied/)
  assert.match(log, /REFUSED reason=automated: precedence: bulk/)
  assert.match(log, /REFUSED reason=automated: null return path \(bounce\)/)
  assert.match(log, /REFUSED reason=own address \(nelly@tiaolabs\.com\) — a mail loop/)
  assert.equal(warns.length, 5, 'each refusal is also a logger warning')
  assert.equal(bot.seen.has('obj:inbound/a'), true, 'a refused object is remembered: it is not re-refused every poll')

  // The same mail delivered twice — the object differs, the Message-ID does not.
  const h2 = await botHarness()
  h2.mailbox.put('inbound/0001', fixture('plain.eml'))
  h2.mailbox.put('inbound/0002', fixture('duplicate.eml'))
  await h2.bot.chain(() => h2.bot.pollOnce())
  await h2.settle()
  assert.equal(h2.agent.seen.followup.length, 1, 'a redelivery of the same Message-ID is not a second turn')
  assert.match(h2.log(), /REFUSED reason=duplicate msg=<plain-0001@example\.com> key=inbound\/0002/)
  h2.close()
  h.close()
  ok('refusals: allowlist, automated, list, bounce, self-addressed, duplicate — each with its reason in the log')
}

{
  // The allowlist empty is a legal but loud configuration.
  const warns = []
  const h = await botHarness({ operators: [] }, { warn: (line) => warns.push(String(line)) })
  h.mailbox.put('inbound/0001', fixture('not-allowed.eml'))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  assert.equal(h.agent.seen.followup.length, 1, 'with no allowlist a stranger reaches the agent')
  assert.match(h.log(), /DISPATCH from=stranger@example\.net session=.* allowlist=OPEN/)
  assert.match(h.log(), /ARMED .*allowlist=OPEN/)
  h.close()
  ok('allowlist: empty means open, and every accepted message says so')
}

{
  // The failure this channel exists to never hide: a composed answer SES refuses.
  const warns = []
  const h = await botHarness({}, { warn: (line) => warns.push(String(line)) })
  const failure = Object.assign(new Error('Email address is not verified. The following identities failed the check: nelly@tiaolabs.com'), { name: 'MessageRejected' })
  h.mailbox.send = async ({ raw, to }) => { h.mailbox.calls.sent.push({ raw, to }); throw failure }
  h.mailbox.put('inbound/0001', fixture('plain.eml'))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  const sessionId = h.sessionId()
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Voici la réponse.' }] } } })
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.settle()
  const log = h.log()
  assert.match(log, /SEND FAILED n=1 to=mathieu@example\.com error=MessageRejected: Email address is not verified/)
  assert.match(log, /UNDELIVERED to=mathieu@example\.com subject="Re: Cave order" kept at /)
  assert.equal(warns.filter((line) => /send failed/.test(line)).length, 1, 'and the failure reaches the logger too')
  const kept = readdirSync(join(h.workdir, 'logs', 'undelivered'))
  assert.equal(kept.length, 1, 'the composed answer is kept on disk')
  const keptRaw = readFileSync(join(h.workdir, 'logs', 'undelivered', kept[0]))
  assert.match((await simpleParser(keptRaw)).text, /Voici la réponse\./, 'byte for byte: an operator can resend it as it stands')
  const attempts = h.mailbox.calls.sent.length
  await h.ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } })
  assert.equal(h.mailbox.calls.sent.length, attempts, 'a failed send is not retried forever')
  h.close()
  ok('send failure: provider text in the log, raw answer kept, failure surfaced, no retry storm')
}

{
  // A transient provider error gets exactly one more attempt.
  const h = await botHarness()
  let attempts = 0
  const throttled = Object.assign(new Error('Rate exceeded'), { name: 'Throttling' })
  h.mailbox.send = async ({ raw, to }) => {
    attempts += 1
    h.mailbox.calls.sent.push({ raw, to })
    if (attempts === 1) throw throttled
    return { messageId: '0100late' }
  }
  h.mailbox.put('inbound/0001', fixture('plain.eml'))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  const sessionId = h.sessionId()
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/start', data: { turn: 1 } })
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Deux.' }] } } })
  h.ctx.handlers['session/event']({ id: sessionId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.settle()
  assert.equal(attempts, 2, 'throttling is retried once')
  assert.match(h.log(), /SEND FAILED n=1 .*error=Throttling/)
  assert.match(h.log(), /SENT n=2 to=mathieu@example\.com id=0100late/)
  assert.equal(retryableSendError(throttled), true)
  assert.equal(retryableSendError(Object.assign(new Error('x'), { name: 'MessageRejected' })), false)
  assert.equal(retryableSendError({ $metadata: { httpStatusCode: 503 } }), true, 'a 5xx is transient even without a name')
  assert.equal(retryableSendError({ $metadata: { httpStatusCode: 400 } }), false)
  h.close()
  ok('send retry: exactly one extra attempt for a transient error, none for a deterministic one')
}

{
  // Which turns are answered at all.
  const h = await botHarness()
  const foreign = h.bot.conversation('someone@example.com')
  foreign.sessionId = 'sm-mail-nelly-elsewhere'
  h.bot.conversation('mathieu@example.com')
  h.ctx.handlers['session/event']({ id: 'sm-mail-nelly-elsewhere' }, { type: 'turn/start', data: { turn: 1 } })
  h.ctx.handlers['session/event']({ id: 'sm-mail-nelly-elsewhere' }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'a scheduled answer' }] } } })
  h.ctx.handlers['session/event']({ id: 'sm-mail-nelly-elsewhere' }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await h.settle()
  assert.equal(h.mailbox.calls.sent.length, 0, 'a turn with no inbound mail behind it sends nothing')
  assert.match(h.log(), /ANSWER-SKIPPED .*no inbound mail to answer/)
  h.ctx.handlers['session/event']({ id: 'sm-mail-nelly-nobody' }, { type: 'turn/end', data: { turn: 9 } })
  await h.settle()
  assert.equal(h.log().includes('nobody'), false, 'events of a session this surface does not own are ignored')
  h.close()
  ok('turn handling: only a turn started by mail is answered by mail')
}

{
  // The poll loop's bounds: a backlog drains in slices, and mail past the dedup TTL is left
  // alone (its identity may already be forgotten, and an old question has no answer worth
  // sending).
  const h = await botHarness({ maxPerPoll: 2, dedupTtlMs: 60 * 60_000 })
  h.mailbox.put('inbound/1', fixture('plain.eml'))
  h.mailbox.put('inbound/2', fixture('multipart-alternative.eml'))
  h.mailbox.put('inbound/3', fixture('no-message-id.eml'))
  h.mailbox.put('inbound/old', fixture('plain.eml'), new Date(Date.now() - 3 * 24 * 60 * 60_000))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  const reached = () => h.agent.seen.followup.length + h.agent.seen.steer.length
  assert.equal(reached(), 2, 'at most maxPerPoll objects per tick')
  assert.equal(h.mailbox.calls.fetched.length, 2, 'and no more than that is even downloaded')
  assert.match(h.log(), /BACKLOG 1 object\(s\) deferred to the next poll \(maxPerPoll=2\)/)
  assert.match(h.log(), /STALE key=inbound\/old age=72h — older than dedupTtlMs, left alone/)
  assert.equal(h.mailbox.calls.fetched.includes('inbound/old'), false, 'a stale object is not even downloaded')
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  assert.equal(reached(), 3, 'the backlog drains on the next tick')

  // Ticks never overlap: a slow bucket must not build a backlog of polls.
  const listingsBefore = h.mailbox.calls.listed
  h.bot.polling = true
  h.bot.tick()
  assert.equal(h.mailbox.calls.listed, listingsBefore, 'a tick while the previous poll runs lists nothing')
  assert.match(h.log(), /POLL-SKIPPED the previous poll is still running/)
  h.bot.polling = false
  h.close()
  ok('poll: maxPerPoll slices a backlog, mail past the TTL is left alone, ticks never overlap')
}

{
  // A restart must not answer yesterday's mail again.
  const dir = mkdtempSync(join(tmpdir(), 'sm-restart-'))
  const workdir = mkdtempSync(join(tmpdir(), 'sm-restart-work-'))
  const config = baseConfig({ cwd: workdir, pollMs: 3_600_000 })
  const agent = fakeAgent()
  const ctx = fakeCtx(agent)
  const make = () => {
    const store = new StateStore(dir, instanceOf(config))
    store.load()
    const mailbox = fakeMailbox()
    const bot = new MailBot({ ctx, config, mailbox, store, logger: ctx.logger, info: { instance: instanceOf(config), cwd: workdir } })
    return { bot, mailbox, store }
  }
  const first = make()
  first.mailbox.put('inbound/0001', fixture('plain.eml'))
  await first.bot.start()
  await first.bot.chain(() => Promise.resolve())
  assert.equal(agent.seen.followup.length, 1)
  first.bot.dispose()

  const second = make()
  second.mailbox.put('inbound/0001', fixture('plain.eml'))
  await second.bot.start()
  await second.bot.chain(() => Promise.resolve())
  assert.equal(agent.seen.followup.length, 1, 'the restarted surface does not re-answer a message it already dispatched')
  assert.equal(second.bot.conversations.get('mathieu@example.com').sessionId, 'sm-mail-nelly-mathieu-example.com', 'and it resumes the same session')
  second.bot.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  ok('restart: bindings and the seen set both survive, so no mail is answered twice')
}

{
  // A pinned sessionId is one conversation, whatever alias writes in.
  const h = await botHarness({ sessionId: 'sm-nelly-wine' })
  h.mailbox.put('inbound/0001', fixture('plain.eml'))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  assert.equal([...h.bot.conversations.keys()].join(','), '*', 'one key, so findBySession cannot be ambiguous')
  assert.equal(h.sessionId(), 'sm-nelly-wine')
  assert.equal(h.bot.conversation('other@example.com').sessionId, 'sm-nelly-wine')
  h.close()
  ok('sessionId: pinned sessions collapse every correspondent into one conversation')
}

{
  // A parse failure is a refusal with a reason, not a silent skip and not a retry loop.
  const h = await botHarness()
  h.mailbox.put('inbound/broken', Buffer.from('\u0000\u0001not really mime at all'))
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  assert.equal(h.agent.seen.followup.length, 0)
  assert.match(h.log(), /REFUSED reason=(unparsable MIME|empty body|no usable From address)/)
  assert.equal(h.bot.seen.has('obj:inbound/broken'), true, 'a message that cannot be parsed is not retried forever')
  h.mailbox.put('inbound/huge', fixture('plain.eml'))
  h.bot.config.maxMessageBytes = 10
  await h.bot.chain(() => h.bot.pollOnce())
  await h.settle()
  assert.match(h.log(), /REFUSED reason=too large \(\d+ bytes > maxMessageBytes\)/)
  assert.equal(h.mailbox.calls.fetched.includes('inbound/huge'), false, 'an oversized object is refused without downloading it')
  h.close()
  ok('bad input: unparsable bytes and oversized objects are refused with a reason')
}

// ------------------------------------------------------- a missing service --
{
  // A composition without the agents service cannot dispatch, but that is not a reason to
  // lose the message: it stays unseen, so the next poll tries again.
  const dir = mkdtempSync(join(tmpdir(), 'sm-noagent-'))
  const workdir = mkdtempSync(join(tmpdir(), 'sm-noagent-work-'))
  const config = baseConfig({ cwd: workdir, pollMs: 3_600_000 })
  const mailbox = fakeMailbox()
  const store = new StateStore(dir, instanceOf(config))
  store.load()
  const ctx = { logger: { info: () => {}, warn: () => {} }, get: () => undefined, on: () => () => {} }
  const bot = new MailBot({ ctx, config, mailbox, store, logger: ctx.logger, info: { instance: instanceOf(config), cwd: workdir } })
  mailbox.put('inbound/0001', fixture('plain.eml'))
  await bot.chain(() => bot.pollOnce())
  assert.equal(bot.seen.has('obj:inbound/0001'), false, 'an undispatchable message is not marked as handled')
  assert.equal(mailbox.calls.sent.length, 0)
  const log = readFileSync(bot.logFile(), 'utf8')
  assert.match(log, /UNAVAILABLE no agent service in this composition — inbound\/0001 left for the next poll/)
  assert.equal(/REFUSED/.test(log), false, 'and it is not a refusal: nothing about the message is wrong')
  bot.dispose()
  rmSync(dir, { recursive: true, force: true })
  rmSync(workdir, { recursive: true, force: true })
  ok('missing service: mail waits for the next poll instead of being dropped')
}

// ------------------------------------------------------------- the transport --
{
  // The AWS seam itself: fake clients in the SDK's own `{ send(command) }` shape.
  const calls = { listed: [], fetched: [], sent: [] }
  const s3 = {
    async send(command) {
      const input = command.input
      if (command.constructor.name === 'ListObjectsV2Command') {
        calls.listed.push(input)
        if (input.ContinuationToken === undefined) {
          return {
            IsTruncated: true,
            NextContinuationToken: 'page2',
            Contents: [
              { Key: 'inbound/newer', LastModified: new Date('2026-10-14T10:00:00Z'), Size: 10 },
              { Key: 'inbound/older', LastModified: new Date('2026-10-14T09:00:00Z'), Size: 20 },
            ],
          }
        }
        return { IsTruncated: false, Contents: [{ Key: 'inbound/oldest', LastModified: new Date('2026-10-14T08:00:00Z'), Size: 30 }] }
      }
      if (command.constructor.name === 'GetObjectCommand') {
        calls.fetched.push(input)
        // A stream, as the real client hands it over.
        return { Body: { async *[Symbol.asyncIterator]() { yield Buffer.from('Subject: x\r\n\r\nhello'); yield Buffer.from(' again') } } }
      }
      throw new Error(`unexpected command ${command.constructor.name}`)
    },
  }
  const ses = {
    async send(command) {
      calls.sent.push({ name: command.constructor.name, input: command.input })
      return { MessageId: '0100fake' }
    },
  }
  const config = baseConfig({ awsRegion: 'eu-west-3' })
  const mailbox = createMailbox({ config, deps: { s3, ses } })
  const listed = await mailbox.list()
  assert.deepEqual(listed.map((item) => item.key), ['inbound/oldest', 'inbound/older', 'inbound/newer'], 'SES keys are not time-ordered: the list is paged whole and sorted oldest-first')
  assert.equal(calls.listed[0].Bucket, 'nelly-mail')
  assert.equal(calls.listed[0].Prefix, 'inbound/')
  assert.equal(calls.listed[1].ContinuationToken, 'page2', 'a truncated listing is followed to the end')
  const raw = await mailbox.fetch('inbound/older')
  assert.equal(raw.toString('utf8'), 'Subject: x\r\n\r\nhello again', 'a streaming body becomes bytes')
  assert.equal(calls.fetched[0].Key, 'inbound/older')

  const sent = await mailbox.send({ raw: Buffer.from('raw'), to: 'mathieu@example.com' })
  assert.equal(sent.messageId, '0100fake')
  assert.equal(calls.sent[0].name, 'SendRawEmailCommand')
  assert.equal(calls.sent[0].input.Source, 'nelly@tiaolabs.com', 'the envelope sender must be the verified identity, not the header')
  assert.deepEqual(calls.sent[0].input.Destinations, ['mathieu@example.com'])
  assert.equal(calls.sent[0].input.RawMessage.Data.toString(), 'raw')

  assert.equal((await readBody(undefined)).length, 0)
  assert.equal((await readBody(Buffer.from('abc'))).toString(), 'abc')
  assert.equal((await readBody({ transformToByteArray: async () => new Uint8Array([104, 105]) })).toString(), 'hi')
  ok('transport: paged listing, streaming body, SendRawEmail envelope, byte-shape handling')
}

// --------------------------------------------------- who actually sent this? --
// An allowlist keyed on `From:` is spoofable, so the header must be backed by SES's verdict.
// The ordering case is the one that matters: SES PREPENDS its Authentication-Results, and the
// header Map keeps the LAST value — i.e. a forged one. Read from the raw lines, first match
// wins, and the forged "dmarc=pass" further down must not rescue a refused message.
{
  const spoof = await parseMail(fixture('spoofed-forged-verdict.eml'), { key: 'inbound/spoof' })
  assert.equal(spoof.from, 'mathieu@example.com', 'the forged From is what the allowlist sees')
  assert.equal(spoof.auth.dmarc, 'fail', "SES's verdict is the one that is read, not the later forgery")
  assert.equal(spoof.auth.spf, 'pass', 'the other verdicts are carried too')
  assert.equal(spoof.auth.dmarcFrom, 'example.com', 'and DMARC is reported for the header domain')

  const good = await parseMail(fixture('authenticated.eml'), { key: 'inbound/good' })
  assert.equal(good.auth.dmarc, 'pass', 'an authenticated message reports dmarc=pass')
  assert.match(authSummary(good.auth), /auth dmarc=pass spf=pass dkim=pass from=example\.com/)

  // (a) default: the header alone decides, as documented
  const lax = await botHarness()
  lax.mailbox.put('inbound/auth1', fixture('spoofed-forged-verdict.eml'))
  await lax.bot.chain(() => lax.bot.pollOnce())
  await lax.settle()
  assert.match(lax.log(), /INBOUND .*auth dmarc=fail/, 'the verdict is logged even when it is not enforced')
  assert.ok(!/REFUSED reason=unauthenticated/.test(lax.log()), 'the default does not enforce it')
  assert.equal(lax.agent.seen.followup.length, 1, 'by default the spoofed sender does start a turn — that is why the check exists')
  lax.close()

  // (b) enforced: the same message is refused, with the verdict in the reason
  const strict = await botHarness({ requireSenderAuth: 'dmarc' })
  strict.mailbox.put('inbound/auth2', fixture('spoofed-forged-verdict.eml'))
  await strict.bot.chain(() => strict.bot.pollOnce())
  await strict.settle()
  assert.match(strict.log(), /REFUSED reason=unauthenticated sender \(want dmarc; auth dmarc=fail/, 'the refusal names the verdict')
  assert.equal(strict.agent.seen.followup.length, 0, 'and no turn was started')

  // (c) enforced, but a genuinely authenticated message still gets through
  strict.mailbox.put('inbound/auth3', fixture('authenticated.eml'))
  await strict.bot.chain(() => strict.bot.pollOnce())
  await strict.settle()
  assert.match(strict.log(), /DISPATCH from=mathieu@example\.com/, 'an authenticated operator is still dispatched')
  assert.equal(strict.agent.seen.followup.length, 1, 'exactly the authenticated one')
  strict.close()

  // (d) a domain with SPF+DKIM but no DMARC: `dmarc` mode refuses it, `aligned` accepts it —
  //     which is the difference between locking the owner out of his own channel and not.
  const noDmarc = await parseMail(fixture('dkim-aligned-no-dmarc.eml'), { key: 'inbound/nd' })
  assert.equal(noDmarc.auth.dmarc, 'none', 'no DMARC record means dmarc=none, not fail')
  assert.deepEqual(noDmarc.auth.dkimDomains, ['example.com'], 'the aligned signing domain is recorded')
  assert.equal(senderAuthenticated('dmarc', noDmarc.auth, noDmarc.from), false, 'strict dmarc refuses it')
  assert.equal(senderAuthenticated('aligned', noDmarc.auth, noDmarc.from), true, 'aligned accepts a DKIM pass for the From domain')
  assert.equal(senderAuthenticated('aligned', noDmarc.auth, 'someone@other.example'), false, 'but not for an unrelated From domain')
  assert.equal(senderAuthenticated('aligned', spoof.auth, spoof.from), false, 'and never for a dmarc=fail message')

  const aligned = await botHarness({ requireSenderAuth: 'aligned' })
  aligned.mailbox.put('inbound/auth4', fixture('dkim-aligned-no-dmarc.eml'))
  await aligned.bot.chain(() => aligned.bot.pollOnce())
  await aligned.settle()
  assert.match(aligned.log(), /DISPATCH from=mathieu@example\.com session=/, 'the no-DMARC owner still gets through in aligned mode')
  aligned.close()
  ok('sender auth: SES verdict is read first-match, logged always, and enforceable')
}

// --------------------------------------------------------------- outbound --
{
  const dir = mkdtempSync(join(tmpdir(), 'ses-outbound-'))
  const quiet = { info() {}, warn() {} }
  const sent = []
  const sender = { sendMarkdown: async (to, md) => { sent.push([to, md]); return true } }
  const drop = (pipe, obj) => {
    const name = `${Date.now()}-${Math.random().toString(16).slice(2, 6)}.json`
    writeFileSync(join(pipe.dir, name), JSON.stringify(obj))
    return name
  }
  const config = Config({ outboundPrimaryChat: 'owner@example.com', politenessNoteRatePerHour: 1, politenessDedupWindowMinutes: 30, politenessChatter: 'never' })
  let clock = Date.UTC(2026, 9, 18, 12)
  const pipe = new OutboundPipe({ ctx: {}, config, sender, logger: quiet, cwd: dir, now: () => clock })
  pipe.setup()

  drop(pipe, { to: 'primary', class: 'alert', text: 'A1' })
  await pipe.tick()
  assert.deepEqual(sent.at(-1), ['owner@example.com', 'A1'], 'alert emits to the primary address immediately')

  drop(pipe, { to: 'primary', class: 'note', text: 'N1' })
  await pipe.tick()
  const n3 = drop(pipe, { to: 'primary', class: 'note', text: 'N2' })
  await pipe.tick()
  assert.ok(!sent.some(([, m]) => m === 'N2'), 'note over budget is held')
  assert.ok(pipe.jsonFiles('held').includes(n3), 'held file present')

  drop(pipe, { to: 'primary', class: 'chatter', text: 'C' })
  await pipe.tick()
  assert.equal(sent.filter(([, m]) => m === 'C').length, 0, 'email chatter is never sent by default (contract mapping)')

  clock += 3600_000
  await pipe.tick()
  assert.ok(sent.some(([, m]) => m === 'N2'), 'held note released when the budget window resets')
  rmSync(dir, { recursive: true, force: true })
  ok('outbound: alert-immediate/note-budget-hold-release/chatter-never (email mapping)')
}

console.log(`\nALL CHECKS PASSED (${checks} groups)`)
