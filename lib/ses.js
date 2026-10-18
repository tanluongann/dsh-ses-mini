/**
 * The AWS side: one mailbox (S3 in, SES out) per row.
 *
 * Deliberately dumb — it lists, fetches bytes and sends bytes. Every decision about what a
 * message *means*, whether it may start a turn and what the answer looks like lives in
 * `mail.js` and `bot.js`, which is what makes those testable without AWS.
 *
 * Credentials are never configuration. Both clients are built with no explicit credentials
 * so the SDK resolves them from the standard chain (`AWS_*` env vars, the shared config
 * file, the EC2/ECS/task role, SSO) — a secret in a config file is a secret in a repo, a
 * profile patch and a shell history.
 */
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { SendRawEmailCommand, SESClient } from '@aws-sdk/client-ses'

/** Bytes behind an S3 `GetObject` body, whatever shape the client hands us. */
export async function readBody(body) {
  if (body === undefined || body === null) return Buffer.alloc(0)
  if (typeof body.transformToByteArray === 'function') return Buffer.from(await body.transformToByteArray())
  if (typeof body[Symbol.asyncIterator] === 'function') {
    const chunks = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk))
    return Buffer.concat(chunks)
  }
  return Buffer.from(body)
}

/**
 * The S3/SES pair, with both clients injectable (`deps.s3` / `deps.ses`).
 *
 * Same seam as the Feishu surface's `deps.createChannel`: the loader never passes a third
 * argument to `apply`, so tests wrap the plugin and hand in fakes — no network, no
 * credentials, no bucket. A fake only has to be `{ send(command) }`, which is the AWS SDK's
 * own shape, so `command.input` is inspectable in assertions.
 */
export function createMailbox({ config, deps = {} }) {
  const region = typeof config.awsRegion === 'string' && config.awsRegion.trim() !== '' ? config.awsRegion.trim() : undefined
  const options = region === undefined ? {} : { region }
  const s3 = deps.s3 ?? new S3Client(options)
  const ses = deps.ses ?? new SESClient(options)

  return {
    s3,
    ses,

    /**
     * Every object under the prefix, oldest first, with its key and metadata.
     *
     * The whole prefix is paged rather than a time window: S3 lists by key, and SES key
     * templates are not time-ordered, so "new since the last poll" cannot be expressed as a
     * listing parameter. Skipping is cheap (it happens in the bot's seen set); missing mail
     * because it sorted onto page two would not be.
     */
    async list() {
      const out = []
      let token
      for (let page = 0; page < 20; page += 1) {
        const response = await s3.send(new ListObjectsV2Command({
          Bucket: config.mailBucket,
          Prefix: config.mailPrefix === '' ? undefined : config.mailPrefix,
          MaxKeys: 1_000,
          ...(token === undefined ? {} : { ContinuationToken: token }),
        }))
        for (const item of response?.Contents ?? []) {
          if (typeof item?.Key !== 'string' || item.Key === '') continue
          out.push({
            key: item.Key,
            lastModified: item.LastModified instanceof Date ? item.LastModified : new Date(0),
            size: Number(item.Size) || 0,
          })
        }
        if (response?.IsTruncated !== true || typeof response?.NextContinuationToken !== 'string') break
        token = response.NextContinuationToken
      }
      // Oldest first, so a backlog is answered in the order it was written.
      return out.sort((a, b) => a.lastModified - b.lastModified)
    },

    /** One object's bytes. */
    async fetch(key) {
      const response = await s3.send(new GetObjectCommand({ Bucket: config.mailBucket, Key: key }))
      return readBody(response?.Body)
    },

    /**
     * Hand one raw MIME message to SES.
     *
     * `Source` is the bare From address and must be a verified identity — SES takes the
     * envelope sender from it, not from the header, and rejects the send (`MessageRejected`)
     * when it is unverified. The display name rides in the MIME header instead, which is why
     * `mail.buildReply` writes both.
     *
     * The error is rethrown untouched: the caller has to be able to write SES's own text to
     * the log, and a swallowed provider error is the failure this channel must never hide.
     */
    async send({ raw, to }) {
      const response = await ses.send(new SendRawEmailCommand({
        RawMessage: { Data: raw },
        Source: config.fromAddress,
        Destinations: [to],
      }))
      return { messageId: response?.MessageId }
    },
  }
}

/**
 * Whether an SES failure is worth exactly one more attempt.
 *
 * Throttling and 5xx are transient by definition and a retry costs nothing but a second;
 * everything else (an unverified identity, a rejected message, a permissions error) is
 * deterministic, and retrying it only doubles the log noise before the same failure.
 */
export function retryableSendError(error) {
  const name = String(error?.name ?? '')
  if (['Throttling', 'ThrottlingException', 'TooManyRequestsException', 'ServiceUnavailable', 'InternalFailure', 'RequestTimeout', 'TimeoutError'].includes(name)) return true
  const status = Number(error?.$metadata?.httpStatusCode)
  return Number.isFinite(status) && status >= 500
}
