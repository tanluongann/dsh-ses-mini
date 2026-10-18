#!/usr/bin/env node
/**
 * Point `node_modules/@deepseek-ai` at the installed dsh closure.
 *
 * The `@deepseek-ai/*` packages are not usable from the public registry: this
 * plugin must resolve *the same* copies the running harness uses, or cordis
 * declaration-merging breaks. The reference plugins solve this with a
 * postinstall that symlinks the global closure into their own node_modules;
 * this does the same for us.
 *
 * Idempotent, and a no-op (exit 0) when no dsh install is found.
 */
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'

const here = dirname(fileURLToPath(import.meta.url))
const root = dirname(here)

function findClosure() {
  const candidates = []
  try {
    const bin = execFileSync('which', ['dsh'], { encoding: 'utf8' }).trim()
    if (bin !== '') candidates.push(join(dirname(bin), '..', '@deepseek-ai'))
  } catch { /* no dsh on PATH — a non-interactive shell usually has none */ }
  // The dsh home is the reliable location: `dsh` may not be on a service's PATH, but its
  // closure always sits under $DSH_HOME/installation/node_modules.
  const home = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  candidates.push(join(home, 'installation', 'node_modules', '@deepseek-ai'))
  candidates.push(join(homedir(), '.dsh', 'installation', 'node_modules', '@deepseek-ai'))
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const closure = findClosure()
if (closure === undefined) {
  console.log('link-closure: no dsh installation found — nothing to link')
  process.exit(0)
}

const target = join(root, 'node_modules', '@deepseek-ai')
mkdirSync(dirname(target), { recursive: true })
rmSync(target, { recursive: true, force: true })
symlinkSync(closure, target, 'dir')
console.log(`link-closure: @deepseek-ai -> ${closure}`)
