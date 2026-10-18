/**
 * Integration test: boot the REAL cordis entry through the REAL registry — real config
 * validation, real `inject` resolution, real fiber + effect lifecycle, real context event
 * emission, the real S3/SES transport factory — with only the two AWS clients replaced by
 * fakes (the `deps.s3` / `deps.ses` seam).
 *
 * This is the test the unit harness cannot be: it proves the plugin is wired the way DSH
 * loads it, that a mail object delivered by SES reaches a real agent turn, that the turn's
 * answer leaves as a properly threaded raw message, and that disposal stops the poll loop.
 *
 * `node test/integration.mjs` — no network, no AWS, no model call.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { simpleParser } from 'mailparser'
import * as plugin from '../lib/index.js'
import { headerValue, rawHeaders } from '../lib/mail.js'

let checks = 0
const ok = (label) => { checks += 1; console.log(`  ✓ ${label}`) }
const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms))
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url))
/** mailparser returns a bare string for a single `References` id and an array for several. */
const referencesOf = (parsed) => [].concat(parsed.references ?? [])

/** The SDK's own `{ send(command) }` shape, backed by a Map. */
function fakeS3() {
  const state = { objects: new Map(), listings: 0, gets: 0, listInputs: [] }
  return {
    state,
    put(key, raw, at = new Date()) { state.objects.set(key, { raw, at }); return key },
    async send(command) {
      const name = command.constructor.name
      if (name === 'ListObjectsV2Command') {
        state.listings += 1
        state.listInputs.push(command.input)
        return {
          IsTruncated: false,
          Contents: [...state.objects.entries()].map(([Key, value]) => ({ Key, LastModified: value.at, Size: value.raw.length })),
        }
      }
      if (name === 'GetObjectCommand') {
        state.gets += 1
        const found = state.objects.get(command.input.Key)
        if (found === undefined) throw new Error(`NoSuchKey: ${command.input.Key}`)
        return { Body: { transformToByteArray: async () => new Uint8Array(found.raw) } }
      }
      throw new Error(`unexpected S3 command ${name}`)
    },
  }
}

function fakeSes(failure) {
  const state = { sent: [], failure }
  return {
    state,
    async send(command) {
      state.sent.push({ name: command.constructor.name, input: command.input })
      if (state.failure !== undefined) throw state.failure
      return { MessageId: `0100-integration-${state.sent.length}` }
    },
  }
}

function fakeAgents() {
  const agent = {
    status: 'idle',
    options: { provider: 'deepseek-official', model: 'deepseek-flash' },
    seen: { followup: [], steer: [], cancel: [] },
    followup(message) { this.seen.followup.push(message); this.status = 'running' },
    steer(message) { this.seen.steer.push(message) },
    cancel(cause, options) { this.seen.cancel.push({ cause, options }); this.status = 'idle' },
  }
  return { agent, service: { get: () => agent, list: () => [agent], resume: async () => { throw new Error('none') }, create: async () => ({ agent }) } }
}

/** Wrap the plugin so the AWS clients are injected without touching lib/. */
function wrapperFor(deps) {
  return {
    name: 'ses-mini-under-test',
    inject: plugin.inject,
    Config: plugin.Config,
    apply: (ctx, config) => plugin.apply(ctx, config, deps),
  }
}

/**
 * One workspace per group. Separate directories on purpose: the instance name (and with it
 * the state file and the log) is derived from the From address, so two groups sharing a
 * workspace would share a session binding and a seen set — and the second group would be
 * answering mail the first one already handled.
 */
const newWorkdir = () => mkdtempSync(join(tmpdir(), 'sm-integration-'))
let workdir = newWorkdir()
const nextWorkdir = () => { rmSync(workdir, { recursive: true, force: true }); workdir = newWorkdir(); return workdir }
const cleanup = () => rmSync(workdir, { recursive: true, force: true })

// ------------------------------------------------ arm through the real fiber --
{
  const ctx = new Context()
  const { agent, service } = fakeAgents()
  ctx.provide('agents', service)
  // profileContext is provided by the host; mimic it so state lands in a temp dir
  ctx.provide('profileContext', { dir: workdir, cwd: workdir, name: 'test' })

  const s3 = fakeS3()
  const ses = fakeSes()
  // The mail is already in the bucket when the surface arms: mail that arrived while the
  // service was down must be answered on the first tick, not after a full interval.
  s3.put('inbound/0001', fixture('plain.eml'))

  const fork = ctx.plugin(wrapperFor({ s3, ses }), {
    mailBucket: 'nelly-mail', mailPrefix: 'inbound/', fromAddress: 'nelly@tiaolabs.com', fromName: 'Nelly',
    operators: ['mathieu@example.com'], cwd: workdir,
    provider: 'deepseek-official', model: 'deepseek-flash',
    // The poll interval is clamped to >= 1000 ms at runtime: SES delivery is not instant and
    // a tighter loop only spends list calls. The test works with the real floor.
    pollMs: 1_000,
  })
  await fork
  assert.equal(fork.state, 2, 'fiber must reach ACTIVE (2)')
  await settle()
  assert.equal(s3.state.listInputs[0].Bucket, 'nelly-mail', 'the configured bucket is what gets listed')
  assert.equal(s3.state.listInputs[0].Prefix, 'inbound/', 'and the configured prefix')
  assert.equal(s3.state.gets, 1, 'the arm-time poll fetched the waiting message')
  ok('plugin arms through the real registry: ACTIVE, config validated, mailbox polled')

  // ------------------------------------------------------------- inbound --
  assert.equal(agent.seen.followup.length, 1, 'a delivered mail becomes a turn')
  assert.match(agent.seen.followup[0].content[0].text, /^\[email from Mathieu D <mathieu@example\.com> · subject "Cave order"/)
  assert.match(agent.seen.followup[0].content[0].text, /Peux-tu confirmer la commande de mardi/)
  const stateFiles = readdirSync(workdir).filter((file) => file.startsWith('ses-mini-'))
  assert.equal(stateFiles.length, 1, 'per-instance state file written on first contact')
  const persisted = JSON.parse(readFileSync(join(workdir, stateFiles[0]), 'utf8'))
  const boundId = persisted.conversations['mathieu@example.com'].sessionId
  assert.match(boundId, /^sm-mail-nelly-/, 'session ids are namespaced by instance')
  assert.equal(Object.keys(persisted.seen).length, 2, 'both the Message-ID and the S3 key are remembered')
  ok('inbound: the delivered object becomes a real turn, and the binding + dedup are persisted')

  // ------------------------------- a real turn lifecycle, answered by email --
  ctx.emit('session/event', { id: boundId }, { type: 'turn/start', data: { turn: 1 } })
  await settle()
  assert.equal(ses.state.sent.length, 0, 'nothing is sent while the turn runs: email has no live surface')
  ctx.emit('session/event', { id: boundId }, { type: 'tool/call', data: { turn: 1, step: 1, name: 'bash' } })
  ctx.emit('session/event', { id: boundId }, { type: 'tool/result', data: { turn: 1, step: 1 } })
  ctx.emit('session/event', { id: boundId }, { type: 'request/context', data: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  ctx.emit('session/event', { id: boundId }, {
    type: 'assistant/message',
    data: { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'Oui — trois caisses, mardi 10h.' }] }, usage: { inputTokens: 20_000, outputTokens: 120 } },
  })
  await settle()
  assert.equal(ses.state.sent.length, 0, 'tool traffic and a mid-turn message do not send mail')
  ctx.emit('session/event', { id: boundId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  assert.equal(ses.state.sent.length, 1, 'the turn end sent exactly one answer')
  const sent = ses.state.sent[0]
  assert.equal(sent.name, 'SendRawEmailCommand')
  assert.equal(sent.input.Source, 'nelly@tiaolabs.com', 'the envelope sender is the verified identity')
  assert.deepEqual(sent.input.Destinations, ['mathieu@example.com'])
  const answer = await simpleParser(sent.input.RawMessage.Data)
  assert.equal(answer.to.value[0].address, 'mathieu@example.com', 'To is the correspondent')
  assert.equal(answer.subject, 'Re: Cave order', 'the subject is threaded')
  assert.equal(answer.inReplyTo, '<plain-0001@example.com>', 'In-Reply-To is the mail being answered')
  assert.deepEqual(referencesOf(answer), ['<plain-0001@example.com>'], 'References carries the chain')
  assert.equal(answer.text, 'Oui — trois caisses, mardi 10h.', 'the answer body is the model text')
  assert.equal(headerValue(rawHeaders(answer), 'auto-submitted'), 'auto-replied', 'our own output is marked auto-submitted')
  ok('turn lifecycle: turn/end → one raw MIME reply, threaded with In-Reply-To/References/Re:')

  // -------------------------------------------------- the poll timer runs --
  const listingsSoFar = s3.state.listings
  const getsSoFar = s3.state.gets
  await settle(1_300)
  assert.ok(s3.state.listings > listingsSoFar, 'the poll timer keeps listing')
  assert.equal(s3.state.gets, getsSoFar, 'and does not re-download what it has already seen')

  agent.status = 'idle'
  s3.put('inbound/0002', fixture('multipart-alternative.eml'))
  const deadline = Date.now() + 4_000
  while (agent.seen.followup.length < 2 && Date.now() < deadline) await settle(100)
  assert.equal(agent.seen.followup.length, 2, 'the next mail the bucket receives is picked up by the timer alone')
  assert.match(agent.seen.followup[1].content[0].text, /dégustation était très belle/)
  ok('poll timer: new objects are delivered without anyone calling poll')

  // ------------------------------------------------------------- dispose --
  await fork.dispose()
  assert.notEqual(fork.state, 2, 'fiber left ACTIVE on dispose')
  const listingsAfterDispose = s3.state.listings
  const followupsAfterDispose = agent.seen.followup.length
  s3.put('inbound/0003', fixture('no-message-id.eml'))
  await settle(1_300)
  assert.equal(s3.state.listings, listingsAfterDispose, 'a disposed surface stops polling')
  assert.equal(agent.seen.followup.length, followupsAfterDispose, 'and delivers nothing')
  ok('dispose: fiber torn down, poll loop stopped, no further delivery')

  // ------------------------------------------------------------ the log --
  const log = readFileSync(join(workdir, 'logs', 'ses-mail.log'), 'utf8')
  assert.match(log, /ARMED instance=mail-nelly bucket=nelly-mail prefix=inbound\//)
  assert.match(log, /INBOUND key=inbound\/0001 msg=<plain-0001@example\.com> from=mathieu@example\.com/)
  assert.match(log, /DISPATCH from=mathieu@example\.com session=sm-mail-nelly-mathieu-example\.com/)
  assert.match(log, /TURN-END session=sm-mail-nelly-mathieu-example\.com turn=1 phase=done rounds=1 tools=1 model=deepseek-flash/)
  assert.match(log, /SEND ATTEMPT n=1 to=mathieu@example\.com from=nelly@tiaolabs\.com subject="Re: Cave order"/)
  assert.match(log, /SENT n=1 to=mathieu@example\.com id=0100-integration-1/)
  ok('log: what arrived, what was dispatched, what was sent — all in <cwd>/logs/ses-mail.log')
}

// ------------------------------------------------ refusals reach the log too --
nextWorkdir()
{
  const ctx = new Context()
  const { agent, service } = fakeAgents()
  ctx.provide('agents', service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  const s3 = fakeS3()
  s3.put('inbound/stranger', fixture('not-allowed.eml'))
  s3.put('inbound/auto', fixture('auto-reply.eml'))
  const fork = ctx.plugin(wrapperFor({ s3, ses: fakeSes() }), {
    mailBucket: 'nelly-mail', fromAddress: 'nelly@tiaolabs.com', operators: ['mathieu@example.com'], cwd: workdir, pollMs: 1_000,
  })
  await fork
  await settle()
  assert.equal(agent.seen.followup.length, 0, 'a non-allowed sender never reaches the agent')
  const log = readFileSync(join(workdir, 'logs', 'ses-mail.log'), 'utf8')
  assert.match(log, /REFUSED reason=not an operator \(from=stranger@example\.net\)/)
  assert.match(log, /REFUSED reason=automated: auto-submitted: auto-replied/)
  await fork.dispose()
  ok('refusals: policy drops are written down with their reason, through the real entry')
}

// ------------------------------------------- a failed send is never swallowed --
nextWorkdir()
{
  const ctx = new Context()
  const { service } = fakeAgents()
  ctx.provide('agents', service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  const s3 = fakeS3()
  s3.put('inbound/0001', fixture('plain.eml'))
  const ses = fakeSes(Object.assign(new Error('Email address is not verified. The following identities failed the check'), { name: 'MessageRejected' }))
  const fork = ctx.plugin(wrapperFor({ s3, ses }), {
    mailBucket: 'nelly-mail', fromAddress: 'nelly@tiaolabs.com', operators: ['mathieu@example.com'], cwd: workdir, pollMs: 1_000,
  })
  await fork
  await settle()
  const stateFile = readdirSync(workdir).filter((file) => file.startsWith('ses-mini-')).sort().at(-1)
  const boundId = JSON.parse(readFileSync(join(workdir, stateFile), 'utf8')).conversations['mathieu@example.com'].sessionId
  ctx.emit('session/event', { id: boundId }, { type: 'turn/start', data: { turn: 1 } })
  ctx.emit('session/event', { id: boundId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'Trois caisses.' }] } } })
  ctx.emit('session/event', { id: boundId }, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } })
  await settle()

  const log = readFileSync(join(workdir, 'logs', 'ses-mail.log'), 'utf8')
  assert.match(log, /SEND FAILED n=1 to=mathieu@example\.com error=MessageRejected: Email address is not verified/)
  assert.match(log, /UNDELIVERED to=mathieu@example\.com subject="Re: Cave order" kept at /)
  const kept = readdirSync(join(workdir, 'logs', 'undelivered'))
  assert.equal(kept.length, 1, 'the composed answer is on disk')
  assert.match((await simpleParser(readFileSync(join(workdir, 'logs', 'undelivered', kept[0])))).text, /Trois caisses\./)
  await fork.dispose()
  ok('failed send: the provider error and the kept message are both on disk, through the real entry')
}

// -------------------------------------------------- the dormant configurations --
nextWorkdir()
{
  for (const [label, config] of [['no mailBucket', { mailBucket: '' }], ['no fromAddress', { mailBucket: 'b' }]]) {
    const ctx = new Context()
    ctx.provide('agents', fakeAgents().service)
    ctx.provide('profileContext', { dir: workdir, cwd: workdir })
    let constructed = 0
    const fork = ctx.plugin({
      name: 'ses-mini-dormant',
      inject: plugin.inject,
      Config: plugin.Config,
      apply: (ctx2, resolved) => plugin.apply(ctx2, resolved, { createMailbox: () => { constructed += 1; return { list: async () => [], fetch: async () => Buffer.alloc(0), send: async () => ({}) } } }),
    }, config)
    await fork
    assert.equal(fork.state, 2, `${label}: must not fail the tree`)
    assert.equal(constructed, 0, `${label}: and must not build a mailbox`)
    await fork.dispose()
  }
  ok('dormant: no bucket or no From address leaves the row mounted, inert and loud')
}

// ---------------------------------------------- invalid config still fails --
nextWorkdir()
{
  const ctx = new Context()
  ctx.provide('agents', fakeAgents().service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  let threw = false
  try {
    const fork = ctx.plugin(wrapperFor({ s3: fakeS3(), ses: fakeSes() }), { mailBucket: 'b', fromAddress: 'a@b', pollMs: 'soon' })
    await fork
  } catch {
    threw = true
  }
  assert.equal(threw, true, 'a bad config must be rejected by schemastery')
  ok('invalid config: rejected (pollMs must be a natural)')
}

// ------------------------------------ the namespace follows the From address --
nextWorkdir()
{
  const ctx = new Context()
  const { service } = fakeAgents()
  ctx.provide('agents', service)
  ctx.provide('profileContext', { dir: workdir, cwd: workdir })
  const s3 = fakeS3()
  s3.put('inbound/0001', fixture('plain.eml'))
  const fork = ctx.plugin(wrapperFor({ s3, ses: fakeSes() }), {
    mailBucket: 'shared-mail', fromAddress: 'Nelly <nelly@tiaolabs.com>', operators: ['mathieu@example.com'], cwd: workdir, pollMs: 1_000,
  })
  await fork
  await settle()
  const files = readdirSync(workdir).filter((file) => file.startsWith('ses-mini-'))
  assert.ok(files.some((file) => file === 'ses-mini-mail-nelly.json'), `the instance namespace must come from the resolved From address, saw ${files.join(', ')}`)
  assert.match(readFileSync(join(workdir, 'logs', 'ses-mail.log'), 'utf8'), /session=sm-mail-nelly-mathieu-example\.com/, 'and it namespaces the session too')
  await fork.dispose()
  ok('instance: the namespace comes from the From address, whatever form the config wrote it in')
}

cleanup()
console.log(`\nALL INTEGRATION CHECKS PASSED (${checks} groups)`)
assert.equal(plugin.name, 'ses-mini')
