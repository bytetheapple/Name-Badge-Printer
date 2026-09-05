/**
 * Versions to choose from, read straight out of the repository.
 *
 * Only the commits that changed something a print server runs — see
 * PATH_THAT_SHIPS. The commit subject is the description: this project writes
 * them at length, so a list of commits is already a list of changes. Tags are folded in on top
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

/**
 * Only commits that touched this path are releases.
 *
 * Everything a print server runs lives under `bridge/` -- the service, its
 * updater and its systemd units included. A push that changes the admin
 * console or an Edge Function produces another commit for a device to be
 * "behind", with nothing in it for the device: the list filled up with
 * versions that were all, to a Pi, the same version.
 *
 * GitHub answers this directly, so it costs no extra request and no extra
 * permission. The consequence worth knowing: a device sitting on a commit that
 * did not touch this path is not found in the list, and its row shows the bare
 * sha without a date. That is honest -- it is running a version nobody would
 * choose today -- and it corrects itself at the next release.
 */
const PATH_THAT_SHIPS = 'bridge'

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
    json(
      `${API}/commits?sha=${BRANCH}&path=${PATH_THAT_SHIPS}&per_page=${HOW_MANY}`,
    ) as Promise<
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

/** ISO-ish and unambiguous. A console read by one person in one place still
 *  does not need 08/09 to mean two different days depending on the reader. */
export function versionDate(iso: string): string {
  return iso ? iso.slice(0, 10) : ''
}

/** One line for a dropdown: any tag, then the date, sha and subject. The date
 *  is what answers "which of these is newer" without counting rows. */
export function describeVersion(v: RepoVersion): string {
  const tag = v.tags.length
    ? `[${v.tags.map((t) => (t.message ? `${t.name}: ${t.message}` : t.name)).join(', ')}] `
    : ''
  return `${tag}${versionDate(v.date)}  ${v.short} — ${v.subject}`
}
