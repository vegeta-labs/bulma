// Which tracked files the public repository holds (rules G3). The development repository keeps internal plans, review
// records, the session handoff and the private name list; everything else is published as a fresh snapshot.
import { execFileSync } from 'node:child_process'

export const DEV_ONLY = [
  /^CLAUDE\.md$/,
  /^docs\/HANDOFF\.md$/,
  /^docs\/PROGRESS\.md$/,
  /^docs\/milestone\.txt$/,
  /^docs\/demo-milestone\.txt$/,
  /^docs\/0[0-9]_[^/]*\.md$/,
  /^docs\/review\//,
  /^private\//,
]

export const isDevOnly = (path) => DEV_ONLY.some((re) => re.test(path))

/** Tracked files that belong in the public repository, from git, not the working tree. */
export const publicFiles = (cwd = '.') =>
  execFileSync('git', ['ls-files', '-z'], { cwd, encoding: 'utf8' })
    .split('\0')
    .filter((p) => p && !isDevOnly(p))
