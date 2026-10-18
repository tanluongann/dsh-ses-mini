/**
 * Configuration schema and resolution.
 *
 * Schemastery, not zod — and note that a plain `z.string()` is OPTIONAL in this
 * dialect: mandatory keys are marked `.required(true)` (see docs/dsh-plugin-protocol).
 *
 * Two keys are deliberately NOT here: any AWS credential. The SDK clients built in
 * `ses.js` resolve credentials from the standard chain (env, shared config, IMDS, task
 * role), so a secret never reaches a config file, a profile patch or this repo.
 */
import z from '@deepseek-ai/schemastery'

export const Config = z.object({
  /** `off` keeps the row mounted but inert (loader-level disable is `disabled:`). */
  mode: z.union([z.const('on'), z.const('off')]).default('on'),
  /**
   * Region for both clients. Empty = let the SDK resolve it from the environment
   * (`AWS_REGION` / shared config), which is what a task role or a local profile
   * normally does; set it explicitly for a bucket that lives outside the default.
   */
  awsRegion: z.string().default(''),
  /**
   * The bucket SES delivers raw MIME into (receipt rule → S3 action).
   *
   * Empty means dormant: the row mounts, logs one line and polls nothing. Same shape as
   * the Feishu surface with no credentials — a missing setting must never fail the tree.
   */
  mailBucket: z.string().default(''),
  /** Key prefix of the receipt rule's S3 action. Keep the trailing slash. */
  mailPrefix: z.string().default('inbound/'),
  /**
   * The address the agent answers from, and the one it must never answer *itself* from.
   *
   * It is also the SES `Source` on every send: SES only accepts a raw send whose envelope
   * sender is a verified identity, and a display-name-only header would be refused with
   * `MessageRejected`. Empty = dormant (a surface that receives mail and cannot answer is
   * exactly the failure this plugin exists to prevent).
   */
  fromAddress: z.string().default(''),
  /** Display name for the From header. Empty = a bare address. */
  fromName: z.string().default(''),
  /** Optional Reply-To. Useful when answers should land in a human's mailbox. */
  replyTo: z.string().default(''),
  /**
   * Sender allowlist (addr-spec, case-insensitive). Empty = anyone who can reach the
   * mailbox may drive the agent — legal, and logged LOUDLY on every accepted message,
   * because on an address that also receives newsletters it is a live hazard.
   */
  operators: z.array(String).default([]),
  /**
   * How strongly to trust the `From:` of a message that passed the allowlist.
   *
   * `off` — the header alone decides, which is spoofable: anyone who can send mail to this
   * address can write the owner's address in `From:` and drive the agent.
   * `dmarc` — also require SES's own verdict to show `dmarc=pass`, i.e. SPF or DKIM aligned
   * with the From domain. That is the claim an impersonator cannot make, so it is what the
   * owner's channel should use.
   *
   * A refusal logs the full verdict (dmarc/spf/dkim, and the domain DMARC was evaluated for),
   * so a legitimate sender broken by their own SPF/DKIM setup is diagnosable, not mysterious.
   */
  requireSenderAuth: z.union([z.const('off'), z.const('dmarc'), z.const('aligned')]).default('off'),
  /**
   * Milliseconds between S3 listings. Clamped to >= 1000 s at runtime: SES delivery is
   * not instant, and a tighter loop only spends list calls.
   */
  pollMs: z.natural().default(30_000),
  /**
   * Objects handed to the agent per poll, oldest first. A backlog drains over several
   * polls instead of spawning a burst of turns against one session.
   */
  maxPerPoll: z.natural().default(10),
  /**
   * How long a `Message-ID` (and S3 key) stays in the seen set.
   *
   * This is also the age limit for unprocessed mail: an object older than the TTL is left
   * alone, so the seen set can never be pruned into reprocessing a stale message. Two
   * weeks is far longer than any mail that still deserves an answer, and the value is
   * persisted, so a restart cannot replay yesterday's inbox.
   */
  dedupTtlMs: z.natural().default(14 * 24 * 60 * 60_000),
  /** Cap on the persisted seen set (oldest evicted first). Bounded so the file stays small. */
  seenMaxEntries: z.natural().default(2_000),
  /** Inbound body handed to the model, after quote-stripping. Cut here, with a marker. */
  maxBodyChars: z.natural().default(20_000),
  /** Refuse to download an S3 object larger than this (a runaway attachment). */
  maxMessageBytes: z.natural().default(10 * 1_048_576),
  /**
   * Appended to every answer under the RFC 3676 `-- ` delimiter. Empty = no signature;
   * the delimiter is not emitted on its own.
   */
  signature: z.string().default(''),
  /**
   * Quote the message being answered under the answer.
   *
   * Off by default: `In-Reply-To` + `References` are what thread the reply in every modern
   * client, and quoting the question back doubles the mail for no gain. On, it is what a
   * human correspondent expects and what an archive that does not thread needs.
   */
  includeQuotedOriginal: z.boolean().default(false),
  /** Characters of the original kept by `includeQuotedOriginal`. */
  quoteChars: z.natural().default(1_200),
  /**
   * Where the event log is appended. Empty = `<cwd>/logs/ses-mail.log`. Relative paths
   * resolve against `cwd`.
   *
   * Not optional in spirit: the DSH logger does not reach this service's stdout, so this
   * file is the only place that shows what the mailbox actually delivered, why a message
   * was refused, and whether an answer was handed to SES or refused by it.
   */
  logPath: z.string().default(''),
  /** New sessions are created in this directory (default: the profile cwd). */
  cwd: z.string().default(''),
  /** Route for sessions this surface creates; empty = the host's agent default. */
  provider: z.string().default(''),
  model: z.string().default(''),
  /**
   * Per-channel reasoning-effort override for sessions this surface owns
   * (CHANNEL-CONTRACT §2). Empty = inherit the profile/session default.
   */
  reasoningEffort: z.string().default(''),
  /** CHANNEL-CONTRACT §3/§4: address that `to: "primary"` resolves to (the owner). */
  outboundPrimaryChat: z.string().default(''),
  /** Politeness (flat keys, contract §4). Email mapping: chatter = never sent by default. */
  politenessQuietHours: z.string().default(''),
  politenessNoteRatePerHour: z.number().default(4),
  politenessDedupWindowMinutes: z.number().default(30),
  /** Chatter policy: 'quiet-hours' (chat transports) or 'never' (email default). */
  politenessChatter: z.string().default('quiet-hours'),
  /** A message sent while a turn runs is steered into it (Jeremy's requirement). */
  steerMidTurn: z.boolean().default(true),
  /**
   * Pin every conversation to this session id instead of one session per correspondent.
   *
   * For a single-owner mailbox this is usually what you want: the agent keeps one
   * continuous memory of the person who mails it, whichever alias they use. Empty = the
   * derived, per-sender id (`sessionIdOf`).
   */
  sessionId: z.string().default(''),
  /** Namespace for the state file and derived session ids (default: `mail-<localpart>`). */
  instance: z.string().default(''),
})

/**
 * One addr-spec, normalised: display name dropped, `<…>` unwrapped, lowercased.
 *
 * Allowlists and self-checks compare these strings, so this is the single place that
 * decides what "the same address" means — `Mathieu <M@Example.COM>` and `m@example.com`
 * are one correspondent, and a rule that disagreed would either let a stranger in or
 * refuse the owner.
 */
export function normaliseAddress(value) {
  if (typeof value !== 'string') return ''
  const angled = value.match(/<([^<>]*)>/)
  const raw = (angled === null ? value : angled[1]).trim()
  if (raw === '') return ''
  return raw.toLowerCase()
}

/** Whether inbound policy is "anyone" (a loud condition, not a default). */
export function allowlistOpen(config) {
  return !Array.isArray(config?.operators) || config.operators.length === 0
}

/** Poll interval, clamped so `pollMs: 0` cannot turn the loop into a spin. */
export function pollIntervalMs(config) {
  const ms = Number(config?.pollMs)
  return Number.isFinite(ms) && ms >= 1_000 ? ms : 30_000
}

/**
 * Stable per-surface namespace: explicit `instance`, else the From local part.
 *
 * Derived from the RESOLVED From address so that two rows in one profile — a personal
 * mailbox and a shared one — cannot land on the same state file and quietly share a
 * correspondent's session.
 */
export function instanceOf(config) {
  if (typeof config.instance === 'string' && config.instance.trim() !== '') return config.instance.trim()
  const address = normaliseAddress(config?.fromAddress)
  const local = address.split('@')[0].replace(/[^a-z0-9]/g, '')
  return local === '' ? 'default' : `mail-${local}`
}

/** The log file: explicit `logPath` (relative to cwd), else `<cwd>/logs/ses-mail.log`. */
export function logPathFor(config, cwd, join) {
  const raw = typeof config?.logPath === 'string' ? config.logPath.trim() : ''
  if (raw === '') return join(cwd, 'logs', 'ses-mail.log')
  return raw.startsWith('/') ? raw : join(cwd, raw)
}

/** Every address this surface owns: the From and the optional Reply-To. */
export function ownAddresses(config) {
  const out = []
  for (const value of [config?.fromAddress, config?.replyTo]) {
    const address = normaliseAddress(value)
    if (address !== '' && !out.includes(address)) out.push(address)
  }
  return out
}
