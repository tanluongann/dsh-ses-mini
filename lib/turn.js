/**
 * Turn state: the pure event→state fold behind one answer.
 *
 * The Feishu surface's version of this file also carries everything the live card draws —
 * phases for the status line, tool rows, reasoning tails, usage for the footer. Email has no
 * card and no footer: what survives here is only what the *answer* needs (the final
 * assistant text and why the turn ended) plus what the *log* needs (route, duration, tool
 * count). Keeping the shape familiar makes the two surfaces readable side by side.
 *
 * Everything is defensive on purpose — a channel must never crash (or "eat" a turn) because
 * a host payload grew a field. Unknown event types are ignored, unknown content shapes
 * degrade to empty text.
 */

export function initialTurn() {
  return {
    running: false,
    phase: 'idle', // idle | thinking | tool | writing | done | failed | stopped
    turn: 0,
    step: 0,
    startedAt: undefined,
    endedAt: undefined,
    endReason: undefined,
    tools: 0,
    currentTool: undefined,
    rounds: 0,
    lastText: '',
    model: undefined,
    provider: undefined,
    errorLine: undefined,
  }
}

/**
 * Text blocks of a message content payload, joined.
 *
 * Joined without a separator, mirroring the Feishu surface: DSH splits a response into one
 * `assistant/message` per model round-trip, so several text blocks in one payload are
 * fragments of the same sentence, not paragraphs.
 */
export function textOf(content) {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    if (typeof block.text === 'string' && (block.type === 'text' || block.type === undefined)) parts.push(block.text)
  }
  return parts.join('')
}

function beginTurn(state, time) {
  state.running = true
  state.phase = 'thinking'
  state.startedAt = time
  state.endedAt = undefined
  state.endReason = undefined
  state.tools = 0
  state.currentTool = undefined
  state.rounds = 0
  state.lastText = ''
  state.errorLine = undefined
}

function endTurn(state, time, reason) {
  state.running = false
  state.endedAt = time
  state.endReason = reason
  state.currentTool = undefined
  const kind = reason?.kind ?? reason
  state.phase = kind === 'completed' ? 'done'
    : kind === 'error' ? 'failed'
      : kind === 'aborted' ? 'stopped'
        : 'done'
}

/** Fold one durable `session/event` of the bound session. */
export function foldEvent(state, event, time = Date.now()) {
  if (event === null || typeof event !== 'object') return state
  const data = event.data ?? event // payloads ride `.data` on the firehose
  switch (event.type) {
    case 'turn/start':
      beginTurn(state, time)
      if (typeof data.turn === 'number') state.turn = data.turn
      break
    case 'turn/end':
      if (typeof data.turn === 'number') state.turn = data.turn
      endTurn(state, time, data.reason)
      break
    case 'step/start':
      if (typeof data.step === 'number') state.step = data.step
      break
    case 'tool/call':
      state.currentTool = { name: String(data.name ?? 'tool'), startedAt: time }
      state.phase = 'tool'
      break
    case 'tool/result':
      state.tools += 1
      state.currentTool = undefined
      state.phase = 'thinking'
      break
    case 'assistant/message': {
      state.rounds += 1
      const text = textOf(data.message?.content)
      // Only a NON-EMPTY message replaces the answer. A tool-only round comes through as an
      // `assistant/message` with no text blocks, and letting that clear `lastText` would
      // mail the owner an empty turn for a turn that had already written its answer.
      if (text !== '') state.lastText = text
      state.phase = state.running ? 'thinking' : state.phase
      break
    }
    case 'request/context':
      if (typeof data.provider === 'string') state.provider = data.provider
      if (typeof data.model === 'string') state.model = data.model
      break
    case 'request/header': {
      const cfg = data.header?.config
      if (cfg !== null && typeof cfg === 'object') {
        if (typeof cfg.model === 'string') state.model = cfg.model
        if (typeof cfg.provider === 'string') state.provider = cfg.provider
      }
      break
    }
    case 'llm/retry':
      state.errorLine = 'retrying'
      break
    default:
      break
  }
  return state
}

/** Duration for the log line: `12s`, `2m41s`. */
export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const s = ms / 1000
  if (s < 10) return `${s.toFixed(1)}s`
  if (s < 60) return `${Math.round(s)}s`
  const m = Math.floor(s / 60)
  return `${m}m${String(Math.round(s - m * 60)).padStart(2, '0')}s`
}
