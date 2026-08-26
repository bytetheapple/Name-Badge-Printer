/**
 * Versions to choose from, read straight out of the repository.
 *
 * The commit subject is the description — this project writes them at length,
 * so a list of commits is already a list of changes. Tags are folded in on top
 * of that, with their annotation message when they have one.
 *
 * Read-only, and unauthenticated on purpose. Creating a tag would need
 * `contents: write`, which is the same permission as pushing code — and every
 * Pi fetches from this repository and checks out what it is told. A write
 * credential here would join "a leaked Supabase secret" to "arbitrary code as
 * root on every customer's device". Tagging stays on a human's machine.
 */
const REPO = 'bytetheapple/Name-Badge-Printer'
const API = `https://api.github.com/repos/${REPO}`
const BRANCH = 'main'
const HOW_MANY = 40

export interface RepoVersion {
  sha: string
  short: string
  subject: string
  date: string
  /** Tag names pointing at this commit, and their annotation if they carry one. */
  tags: { name: string; message: string | null }[]
}

async function json(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { Accept: 'application/vnd.github+json' } })
  if (!res.ok) {
    // 403 here is nearly always the unauthenticated rate limit — 60 an hour per
    // address — rather than anything being wrong. Say which, since the remedy
    // is "wait" rather than "investigate".
    if (res.status === 403 || res.status === 429) {
      throw new Error('GitHub is rate-limiting this address. It clears within the hour.')
    }
    throw new Error(`GitHub returned ${res.status}`)
  }
  return res.json()
}

/**
 * Tag names by the commit they point at.
 *
 * An annotated tag points at a tag object, which points at the commit, so
 * resolving one costs an extra request. Lightweight tags point straight at the
 * commit and cost nothing. Only annotated ones are followed, and only a few
 * exist, so this stays within the unauthenticated budget.
 */
async function tagsByCommit(): Promise<Map<string, { name: string; message: string | null }[]>> {
  const out = new Map<string, { name: string; message: string | null }[]>()
  let refs: { ref: string; object: { sha: string; type: string } }[] = []
  try {
    refs = (await json(`${API}/git/matching-refs/tags/`)) as typeof refs
  } catch {
    return out // no tags, or unreachable: the commit list is still worth having
  }

  for (const r of refs.slice(-25)) {
    const name = r.ref.replace('refs/tags/', '')
    let sha = r.object.sha
    let message: string | null = null
    if (r.object.type === 'tag') {
      try {
        const obj = (await json(`${API}/git/tags/${r.object.sha}`)) as {
          message?: string
          object?: { sha: string }
        }
        message = (obj.message ?? '').trim().split('\n')[0] || null
        if (obj.object?.sha) sha = obj.object.sha
      } catch {
        // Keep the name; the annotation is a bonus, not the point.
      }
    }
    out.set(sha, [...(out.get(sha) ?? []), { name, message }])
  }
  return out
}

export async function repoVersions(): Promise<RepoVersion[]> {
  const [commits, tags] = await Promise.all([
    json(`${API}/commits?sha=${BRANCH}&per_page=${HOW_MANY}`) as Promise<
      { sha: string; commit: { message: string; committer: { date: string } } }[]
    >,
    tagsByCommit(),
  ])

  return commits.map((c) => ({
    sha: c.sha,
    short: c.sha.slice(0, 7),
    subject: c.commit.message.split('\n')[0],
    date: c.commit.committer.date,
    tags: tags.get(c.sha) ?? [],
  }))
}

/** One line for a dropdown: the tag if there is one, then the sha and subject. */
export function describeVersion(v: RepoVersion): string {
  const tag = v.tags.length
    ? `[${v.tags.map((t) => (t.message ? `${t.name}: ${t.message}` : t.name)).join(', ')}] `
    : ''
  return `${tag}${v.short} — ${v.subject}`
}
