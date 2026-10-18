/**
 * Per-instance state, stored inside the *profile* directory.
 *
 * Same reasoning as the Feishu surface it is modelled on: the file name carries the
 * instance namespace, so two mailboxes on one host (a personal one and a shared one, or
 * two rows in one profile) can never overwrite each other's session bindings.
 *
 * Two maps are kept:
 *   - `conversations`: correspondent address → the session that answers them, so a restart
 *     resumes the same session rather than starting a stranger with no history;
 *   - `seen`: the dedup identities (see `dedup.js`). This one is not a convenience — it is
 *     what stops a restart from re-answering mail that was already answered.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const EMPTY = { version: 1, conversations: {}, seen: {} }

export class StateStore {
  constructor(directory, instance) {
    this.path = join(directory, `ses-mini-${instance}.json`)
    this.data = { ...EMPTY }
  }

  load() {
    try {
      const raw = readFileSync(this.path, 'utf8')
      const parsed = JSON.parse(raw)
      if (parsed !== null && typeof parsed === 'object') {
        this.data = {
          ...EMPTY,
          ...parsed,
          conversations: parsed.conversations ?? {},
          seen: parsed.seen ?? {},
        }
        return this.data
      }
    } catch {
      // missing or malformed: start clean rather than refusing to arm
    }
    this.data = { ...EMPTY }
    return this.data
  }

  get() {
    return this.data
  }

  update(patch) {
    this.data = { ...this.data, ...patch }
    this.save()
    return this.data
  }

  save() {
    try {
      mkdirSync(dirname(this.path), { recursive: true })
      const tmp = `${this.path}.tmp`
      writeFileSync(tmp, `${JSON.stringify(this.data, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      // persistence is best-effort: a read-only profile dir must not kill the poll loop
    }
  }
}
