/**
 * Cordis entry — the object-plugin shape the loader accepts:
 * `{ name, inject, Config, apply(ctx, config) }`.
 *
 * Design rule: this file and `bot.js` are the only DSH-aware code. If the host renames a
 * service, an event or a payload field, the damage is contained here and reported as one log
 * line instead of a half-alive mailbox.
 */
import { Config, instanceOf, normaliseAddress } from './config.js'
import { createMailbox } from './ses.js'
import { MailBot } from './bot.js'
import { StateStore } from './state.js'
import { OutboundPipe } from './outbound.js'

export const name = 'ses-mini'
/** The one seam we cannot work without; everything else is feature-detected. */
export const inject = ['agents']
export { Config }

/**
 * @param ctx - cordis context
 * @param config - schema-resolved config
 * @param deps - test seam: `{ createMailbox, s3, ses }` may be injected so the entry can be
 *   exercised without AWS. `createMailbox` replaces the transport factory outright; `s3` and
 *   `ses` are handed to the real one, which is the narrower seam the integration test uses
 *   (the real factory, real MIME, fake clients — no credentials, no bucket). The loader never
 *   passes a third argument (cordis forwards only the outer stack), so tests wrap this plugin
 *   instead — see test/integration.mjs.
 */
export function apply(ctx, config, deps = {}) {
  const log = ctx.logger ?? console
  if (config.mode === 'off') {
    log.info?.('ses-mini: mode off — row mounted but inert')
    return
  }
  // Dormant, not failed. A row without a mailbox cannot poll, and a row without a From
  // address can receive mail it could never answer — the one outcome this surface exists to
  // prevent — so both cases report themselves in one line and leave the tree alone.
  if (config.mailBucket.trim() === '') {
    log.warn?.('ses-mini: no mailBucket — dormant, nothing polled')
    return
  }
  if (normaliseAddress(config.fromAddress) === '') {
    log.warn?.('ses-mini: no fromAddress — dormant (mail could be received but never answered)')
    return
  }

  const profile = ctx.profileContext ?? ctx.get?.('profileContext') ?? {}
  const directory = typeof profile.dir === 'string' && profile.dir !== '' ? profile.dir : process.cwd()
  const cwd = config.cwd !== ''
    ? config.cwd
    : (typeof profile.cwd === 'string' && profile.cwd !== '' ? profile.cwd : process.cwd())
  const instance = instanceOf(config)

  // Footer-style derived values are resolved once: the config here is already schema-resolved.
  const resolved = { ...config, operators: config.operators.map((value) => normaliseAddress(value)) }

  const store = new StateStore(directory, instance)
  store.load()

  const mailbox = (deps.createMailbox ?? createMailbox)({ config: resolved, deps })
  const bot = new MailBot({
    ctx,
    config: resolved,
    mailbox,
    store,
    logger: log,
    info: { instance, cwd, directory },
  })

  if (bot.allowlistOpen()) {
    log.warn?.(`ses-mini: no operators configured — anyone who can reach ${config.mailBucket}/${config.mailPrefix} may drive this agent`)
  }

  // Body runs immediately; the returned function is the disposer.
  const outbound = new OutboundPipe({ ctx, config, channel, sender: bot, logger: log, cwd })

  ctx.effect(() => {
    void bot.start().catch((error) => {
      log.warn?.(`ses-mini: start failed: ${error?.message ?? String(error)}`)
    })
    outbound.start()
    return () => {
      bot.dispose()
      outbound.dispose()
    }
  })

  ctx.effect(() => {
    const offEvent = ctx.on('session/event', (session, event) => {
      try {
        bot.onSessionEvent(session, event)
      } catch (error) {
        log.warn?.(`ses-mini: event fold failed: ${error?.message ?? String(error)}`)
      }
    })
    // No `agent/assistant-stream` subscription: the Feishu surface folds deltas to draw a live
    // card, and email has no live surface. The final answer is collected from
    // `assistant/message` in the durable event stream, which is the same text without the
    // streaming traffic.
    return () => offEvent?.()
  })

  log.info?.(`ses-mini: row active (instance ${instance}, mailbox ${config.mailBucket}/${config.mailPrefix}, cwd ${cwd})`)
}
