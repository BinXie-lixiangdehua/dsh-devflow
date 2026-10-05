/**
 * Installer candidate resolution for the installer-contract specs.
 *
 * `install.ps1` exists in two places: this repository (the source of truth) and
 * the separate release copy (`DevFlow-dist`) that PM owns. The contract specs
 * must assert against the repository copy first; the release copy is an optional
 * second source, readable only when someone actually has one checked out. A
 * machine that has neither is an absent ENVIRONMENT, not a broken installer, so
 * the callers skip rather than fail — but nothing is skipped while a candidate
 * is readable.
 *
 * Order is: `DEVFLOW_INSTALLER` (an explicit override, also what lets a machine
 * simulate "no candidate" without moving files), then this repository's copy,
 * then `<DEVFLOW_DIST_ROOT>/install.ps1` (default `<repo>/../DevFlow-dist`).
 *
 * @module devflow-tests/installer-candidates
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** This repository's root, derived from the test tree's own location. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')

/** The repository's own installer — the first real candidate (J1). */
export const REPO_INSTALLER = join(REPO_ROOT, 'install.ps1')

/** Where a release copy would live by default; never required to exist. */
const DEFAULT_DIST_ROOT = resolve(REPO_ROOT, '..', 'DevFlow-dist')

/** Every installer path to try, in priority order, with no duplicates. */
export function installerCandidates(): string[] {
  const explicit = process.env.DEVFLOW_INSTALLER
  const distRoot = process.env.DEVFLOW_DIST_ROOT ?? DEFAULT_DIST_ROOT
  const paths = explicit !== undefined && explicit !== ''
    ? [explicit]
    : [REPO_INSTALLER, join(distRoot, 'install.ps1')]
  return [...new Set(paths)]
}

/**
 * Read the first readable installer.
 * @returns the readable installer, or `undefined` when no candidate exists.
 */
export function readInstallerCandidate(): { path: string, text: string } | undefined {
  const candidates = installerCandidates()
  for (const path of candidates) {
    try {
      return { path, text: readFileSync(path, 'utf8') }
    } catch {
      // Missing or unreadable candidate: try the next one.
    }
  }
  return undefined
}

/**
 * A one-line, log-friendly statement of what was tried, for the skip message.
 * @param candidates - the paths that were attempted.
 */
export function describeCandidates(candidates: readonly string[]): string {
  const missing = candidates.filter(path => !existsSync(path))
  const tried = candidates.map(path => `${path}${existsSync(path) ? '' : ' (missing)'}`).join(', ')
  return `tried ${tried}${missing.length === candidates.length ? ' — none exist' : ''}`
}
