export const quote = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"') + '"'
const jqlId = id => /^\d+$/.test(id) ? id : quote(id)
export const currentQuery = scope => `project = ${jqlId(scope.project.id)} AND fixVersion = ${jqlId(scope.version.id)}`
export const configFromEnv = (env = process.env) => ({
  baseUrl: env.JIRA_URL,
  email: env.JIRA_EMAIL,
  token: env.JIRA_API_TOKEN,
  timezone: env.JIRA_TIMEZONE,
  points: env.JIRA_STORY_POINTS_FIELD,
  eon: 'customfield_13756',
  links: JSON.parse(env.JIRA_LINK_TYPES ?? '{}'),
  workflow: JSON.parse(env.JIRA_WORKFLOW_ORDER ?? '{}'),
  verifiedFleetCoverage: env.JIRA_VERIFIED_FLEET_COVERAGE === 'true'
})

export function jiraClient(config, fetcher = fetch) {
  const base = new URL(config.baseUrl)
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash) {
    throw new Error('JIRA_URL must be an HTTPS Jira site URL.')
  }
  if (!config.email || !config.token) throw new Error('JIRA_EMAIL and JIRA_API_TOKEN are required.')
  const baseUrl = base.href.replace(/\/$/, '')
  const authorization = 'Basic ' + Buffer.from(config.email + ':' + config.token).toString('base64')
  async function request(path, params, body) {
    const url = new URL(baseUrl + '/rest/api/3' + path)
    for (const [key, value] of Object.entries(params ?? {})) url.searchParams.set(key, value)
    for (let attempt = 0; ; attempt++) {
      const response = await fetcher(url, {
        method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(30000),
        headers: { authorization, accept: 'application/json', 'content-type': 'application/json' },
        body: body && JSON.stringify(body)
      })
      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        const retry = response.headers.get('retry-after')
        const delay = retry == null ? 500 * (attempt + 1)
          : /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now()
        if (!Number.isFinite(delay) || delay > 30000) throw new Error(`Jira HTTP ${response.status}`)
        await new Promise(resolve => setTimeout(resolve, Math.max(0, delay)))
        continue
      }
      if (!response.ok) throw new Error(`Jira HTTP ${response.status}`)
      return response.json()
    }
  }
  async function pages(load, key, tokenized = false) {
    const values = []
    const seen = new Set()
    let cursor = tokenized ? undefined : 0
    try {
      for (;;) {
        if (seen.has(cursor)) throw new Error('Jira repeated a pagination cursor.')
        seen.add(cursor)
        const page = await load(cursor)
        if (!Array.isArray(page[key])) throw new Error('Jira returned an invalid page.')
        const rows = page[key]
        values.push(...rows)
        if (page.isLast === true || (!tokenized && Number.isInteger(page.total) &&
            cursor + rows.length >= page.total)) break
        if (tokenized && page.nextPageToken) cursor = page.nextPageToken
        else if (!tokenized && rows.length && (page.isLast === false || Number.isInteger(page.total))) cursor += rows.length
        else throw new Error('Jira pagination ended without a completion marker.')
      }
      return { values, complete: true }
    } catch (error) {
      return { values, complete: false, error: error.message }
    }
  }
  return {
    baseUrl,
    async project(selector) {
      try { return await request('/project/' + encodeURIComponent(selector)) }
      catch (error) { if (error.message !== 'Jira HTTP 404') throw error }
      const matches = await pages(startAt => request('/project/search', {
        query: selector, startAt, maxResults: 100
      }), 'values')
      if (!matches.complete) throw new Error('Project search: ' + matches.error)
      const exact = matches.values.filter(project => project.name === selector)
      if (exact.length !== 1) throw new Error('Fleet name did not identify exactly one visible project. Use the Jira project key.')
      return exact[0]
    },
    async versions(id) {
      const result = await pages(startAt => request('/project/' + encodeURIComponent(id) + '/version',
        { startAt, maxResults: 100 }), 'values')
      if (!result.complete) throw new Error('Project versions: ' + result.error)
      return result.values
    },
    async timezone() { return (await request('/myself')).timeZone || 'UTC' },
    configuration: () => request('/field'),
    status: id => request('/status/' + encodeURIComponent(id)),
    search: (jql, fields) => pages(nextPageToken =>
      request('/search/jql', null, { jql, fields, maxResults: 100, nextPageToken }), 'issues', true),
    issue: (id, fields) => request('/issue/' + encodeURIComponent(id), { fields: fields.join(',') }),
    history: id => pages(startAt => request('/issue/' + encodeURIComponent(id) + '/changelog',
      { startAt, maxResults: 100 }), 'values'),
    comments: id => pages(startAt => request('/issue/' + encodeURIComponent(id) + '/comment',
      { startAt, maxResults: 100 }), 'comments'),
    version: id => request('/version/' + encodeURIComponent(id))
  }
}

const unique = rows => [...new Map(rows.map(row => [String(row.id), row])).values()]
const byId = (left, right) => String(left.id).localeCompare(String(right.id), 'en', { numeric: true })
const relevant = /^(blocks|is blocked by|depends on|is depended on by|relates to)$/i

function direction(link, mappings) {
  const side = link.outwardIssue ? 'outward' : 'inward'
  const caption = link.type?.[side]?.trim().toLowerCase()
  const configured = mappings[link.type?.id]?.[side]
  if (['upstream', 'downstream', 'related'].includes(configured)) return configured
  const standard = { blocks: 'downstream', 'is blocked by': 'upstream',
    'depends on': 'upstream', 'is depended on by': 'downstream', 'relates to': 'related' }
  return standard[caption]
}

export async function collect(jira, scope, config) {
  const gaps = {}
  const gap = (dataset, detail) => { (gaps[dataset] ??= new Set()).add(detail) }
  async function read(dataset, label, get, fallback) {
    try { return await get() } catch (error) {
      gap(dataset, label + ': ' + error.message)
      return fallback
    }
  }
  const eon = config.eon ?? 'customfield_13756'
  const fields = await read('sizing', 'Field metadata', jira.configuration, [])
  const points = fields.find(field => config.points && field.id === config.points &&
    field.schema?.type === 'number')?.id
  if (!points) gap('sizing', 'Set a verified numeric JIRA_STORY_POINTS_FIELD for this fleet.')
  const requested = ['summary', 'project', 'issuetype', 'status', 'fixVersions', 'components',
    'issuelinks', eon, points].filter(Boolean)
  const [current, fleet] = await Promise.all([
    jira.search(currentQuery(scope), requested),
    jira.search('project = ' + jqlId(scope.project.id), requested)
  ])
  if (!current.complete) gap('current', current.error ?? 'Incomplete current release search.')
  if (!fleet.complete) gap('history', fleet.error ?? 'Incomplete historical candidate search.')
  if (!config.verifiedFleetCoverage) gap('history', 'Historical candidate and permission coverage has not been verified.')
  const history = new Map()
  const comments = new Map()
  const commentCoverage = new Map()
  const currentItems = unique(current.values).sort(byId)
  const candidates = unique([...fleet.values, ...currentItems]).sort(byId)
  async function loadHistory(issue, dataset) {
    const id = String(issue.id)
    if (!history.has(id)) history.set(id, await read(dataset, issue.key, () => jira.history(id),
      { complete: false, values: [] }))
    const result = history.get(id)
    if (!result.complete) gap(dataset, issue.key + ': ' + (result.error ?? 'Incomplete changelog.'))
  }
  for (const issue of candidates) {
    await loadHistory(issue, 'history')
    if (!Object.hasOwn(issue.fields ?? {}, 'fixVersions')) gap('history', issue.key + ': FixVersions unavailable.')
  }
  const links = []
  const linked = new Map()
  const versions = new Map([[scope.version.id, { id: scope.version.id, name: scope.version.name, releaseDate: scope.releaseDate }]])
  async function loadVersion(id) {
    if (!versions.has(id)) versions.set(id, await read('dates', 'Version ' + id, () => jira.version(id), null))
  }
  for (const issue of currentItems) {
    const id = String(issue.id)
    if (!Array.isArray(issue.fields?.issuelinks)) {
      const full = await read('links', issue.key, () => jira.issue(id, ['issuelinks']), null)
      if (Array.isArray(full?.fields?.issuelinks)) (issue.fields ??= {}).issuelinks = full.fields.issuelinks
      else gap('links', issue.key + ': Issue links unavailable.')
    }
    if (!issue.fields?.status?.name) gap('readiness', issue.key + ': Status unavailable.')
    if (!issue.fields?.components?.length) gap('squads', issue.key + ': Components missing.')
    for (const link of unique(issue.fields?.issuelinks ?? [])) {
      const role = direction(link, config.links ?? {})
      if (!role) {
        if (relevant.test(link.type?.name ?? '') || relevant.test(link.type?.outward ?? '') ||
            relevant.test(link.type?.inward ?? '') || Object.hasOwn(config.links ?? {}, link.type?.id)) {
          gap('links', issue.key + ': Unverified link direction for ' + (link.type?.name ?? link.id))
        }
        continue
      }
      const other = link.outwardIssue ?? link.inwardIssue
      if (!other?.id) {
        gap('links', issue.key + ': Linked issue ID unavailable.')
        continue
      }
      const linkedId = String(other.id)
      if (!linked.has(linkedId)) {
        linked.set(linkedId, (await read('linked', other.key ?? linkedId,
          () => jira.issue(linkedId, requested), null)) ?? { id: linkedId, key: other.key, fields: {} })
      }
      links.push({ id: String(link.id), sourceId: id, linkedId, role, type: link.type?.name })
    }
  }
  return {
    current: currentItems, candidates, linked, links, history, comments, versions, gaps,
    points, eon, gap, loadHistory, loadVersion, commentCoverage,
    async loadComments(issue) {
      const id = String(issue.id)
      if (comments.has(id)) return
      const result = await read('comments', issue.key, () => jira.comments(id), { complete: false, values: [] })
      commentCoverage.set(id, result.complete)
      if (!result.complete) gap('comments', issue.key + ': ' + (result.error ?? 'Incomplete comments.'))
      comments.set(id, unique(result.values).sort(byId))
    }
  }
}
