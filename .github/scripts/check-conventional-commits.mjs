// Fails when a PR title or commit would not survive release-please's parser.
//
// release-please skips any commit it cannot parse and treats an unrecognized
// BREAKING CHANGE footer as body text, without reporting either. The change
// then drops out of the release notes, and a breaking change bumps the minor
// version instead of the major. This check runs the same parser release-please
// uses, so what passes here is what the release notes will show.
//
// Squash merges publish the PR title as the commit subject and rebase merges
// publish each commit unchanged, so both are checked. Allowed types are the
// visible changelog sections in release-please-config.json.
import { readFileSync } from 'node:fs'
import { parser, toConventionalChangelogFormat } from '@conventional-commits/parser'

const { GITHUB_TOKEN, GITHUB_REPOSITORY, PR_NUMBER } = process.env
if (GITHUB_TOKEN == null || GITHUB_REPOSITORY == null || PR_NUMBER == null) {
  console.error('GITHUB_TOKEN, GITHUB_REPOSITORY, and PR_NUMBER must be set')
  process.exit(1)
}

const config = JSON.parse(readFileSync('release-please-config.json', 'utf8'))
const types = config.packages['.']['changelog-sections']
  .filter((section) => section.hidden !== true)
  .map((section) => section.type)
if (types.length === 0) {
  console.error('release-please-config.json has no visible changelog sections, so no commit type could pass')
  process.exit(1)
}

async function get(path) {
  const response = await fetch(`https://api.github.com/repos/${GITHUB_REPOSITORY}${path}`, {
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${GITHUB_TOKEN}` },
  })
  if (!response.ok) {
    throw new Error(`GET ${path} returned ${response.status}`)
  }
  return response.json()
}

async function listCommits(number) {
  const commits = []
  for (let page = 1; ; page++) {
    const batch = await get(`/pulls/${number}/commits?per_page=100&page=${page}`)
    commits.push(...batch)
    if (batch.length < 100) {
      return commits
    }
  }
}

function problemWith(message) {
  let commit
  try {
    commit = toConventionalChangelogFormat(parser(message))
  } catch (error) {
    return `${error.message}. Expected "<type>(<scope>)!: <description>", with "!" after the scope`
  }
  if (!types.includes(commit.type)) {
    return `type "${commit.type}" is not one of ${types.join(', ')}`
  }
  const breaking = commit.notes.some((note) => note.title === 'BREAKING CHANGE')
  if (!breaking && /^\s*BREAKING[ -]CHANGE/m.test(message)) {
    return 'mentions BREAKING CHANGE, but only a footer written exactly as "BREAKING CHANGE: <description>" marks the release as breaking'
  }
  return null
}

const pr = await get(`/pulls/${PR_NUMBER}`)
const problems = []

const titleProblem = problemWith(pr.title)
if (titleProblem != null) {
  problems.push(`PR title "${pr.title}": ${titleProblem}`)
}

// Merge commits from syncing the base branch do not reach master: squash
// discards them and rebase merge drops them.
const commits = (await listCommits(PR_NUMBER)).filter((entry) => entry.parents.length <= 1)
for (const entry of commits) {
  const subject = entry.commit.message.split('\n')[0]
  const problem = problemWith(entry.commit.message)
  if (problem != null) {
    problems.push(`commit ${entry.sha.slice(0, 7)} "${subject}": ${problem}`)
  }
}

if (problems.length > 0) {
  console.error('release-please would not parse the following:')
  for (const problem of problems) {
    console.error(`  - ${problem}`)
  }
  process.exit(1)
}
console.log(`PR title and ${commits.length} commit(s) parse as conventional commits`)
