import { dayAt, shiftDay } from './scope.mjs'

export const RULES = {
  'HR-01': 'Epic Changes', 'HR-02': 'Late Additions', 'HR-03': 'Not Ready Inside Three Days',
  'RV-01': 'Scope Churn', 'RV-02': 'Sizing & Scoping Changes', 'RV-03': 'Workflow Regressions',
  'RV-04': 'Flagged or Blocked Work', 'RV-05': 'Readiness',
  'RD-01': 'Application Footprint', 'RD-02': 'Multi-Squad Development',
  'RD-03': 'Shared Application Collisions', 'RD-04': 'Linked FixVersion Changed',
  'RD-05': 'Upstream Ships Too Late', 'RD-06': 'Upstream In Progress at T-2',
  'RD-07': 'Linked Work Reopened', 'RD-08': 'Upstream Not Done'
}
const DONE = new Set(['Ready for PRD', 'Closed'])
const DEVELOPMENT = new Set(['In Development', 'In Progress'])
const issueId = issue => String(issue.id)
const url = (scope, key) => key ? scope.baseUrl + '/browse/' + encodeURIComponent(key) : null
const issueRef = (scope, issue) => ({ id: issueId(issue), key: issue.key, url: url(scope, issue.key),
  summary: issue.fields?.summary, status: issue.fields?.status?.name,
  squads: (issue.fields?.components ?? []).map(component => component.name).sort() })
const fix = change => change.fieldId === 'fixVersions' || /^fix versions?$/i.test(change.field ?? '')
const status = change => change.fieldId === 'status' || change.field === 'status'
const ids = value => String(value ?? '').split(',').map(id => id.trim()).filter(Boolean)
const previous = change => change.fromString ?? change.from ?? null
const next = change => (typeof change.toString === 'string' ? change.toString : change.to) ?? null
const unavailable = 'Unavailable'
const noReason = 'Reason Not Documented'

function events(issue, data, dataset = 'history') {
  const result = data.history.get(issueId(issue))
  const distinct = new Map()
  for (const event of result?.values ?? []) {
    if (!event.id || !Number.isFinite(Date.parse(event.created)) || !Array.isArray(event.items)) {
      data.gap(dataset, issue.key + ': Malformed changelog entry.')
      continue
    }
    distinct.set(String(event.id), { ...event, created: new Date(event.created).toISOString() })
  }
  return [...distinct.values()].sort((a, b) => a.created.localeCompare(b.created) ||
    String(a.id).localeCompare(String(b.id), 'en', { numeric: true }))
}

function membership(issue, data, scope) {
  const target = scope.version.id
  const versionSet = new Set((issue.fields?.fixVersions ?? []).map(version => String(version.id)))
  let known = Boolean(data.history.get(issueId(issue))?.complete && Array.isArray(issue.fields?.fixVersions))
  let belonged = versionSet.has(target)
  const result = []
  for (const event of events(issue, data).reverse()) {
    const after = versionSet.has(target)
    const changes = event.items.filter(fix)
    const from = new Set(changes.flatMap(change => ids(change.from)))
    const to = new Set(changes.flatMap(change => ids(change.to)))
    if (changes.some(change => (change.fromString && !change.from) ||
        (typeof change.toString === 'string' && change.toString && !change.to))) {
      data.gap('history', issue.key + ': A FixVersion change lacks stable version IDs.')
      known = false
    }
    for (const id of to) versionSet.delete(id)
    for (const id of from) versionSet.add(id)
    const before = versionSet.has(target)
    const addition = to.has(target) && !from.has(target)
    const removal = from.has(target) && !to.has(target)
    const scopeChange = addition ? 'Added' : removal ? 'Removed' : null
    belonged ||= before || after || addition || removal
    result.push({ event, scopeChange, associated: scopeChange || (known && before && after) })
  }
  return { belonged, timeline: result.reverse() }
}

function evidence(event, change, index = 0) {
  return { eventId: String(event.id), changeIndex: index,
    field: change.field ?? change.fieldId, previous: previous(change), next: next(change),
    timestamp: event.created, actor: event.author?.displayName ?? event.author?.accountId ?? unavailable,
    reason: noReason }
}

export function textOf(node) {
  if (typeof node === 'string') return node
  if (typeof node?.text === 'string') return node.text
  if (!Array.isArray(node?.content)) return ''
  return node.content.map(textOf).join(node.type === 'paragraph' ? '' : '\n')
}

function eons(issue, field) {
  const raw = issue.fields?.[field]
  return [...new Set((Array.isArray(raw) ? raw : [raw])
    .map(value => value?.value ?? value?.id ?? value).filter(value =>
      (typeof value === 'string' && value.trim()) || typeof value === 'number')
    .map(value => String(value).trim()))].sort()
}

export async function evaluate(scope, data, jira, config, judge) {
  const rules = Object.fromEntries(Object.entries(RULES).map(([id, name]) => [id, {
    id, name, findings: [], gaps: [], state: 'None Detected'
  }]))
  const add = (id, finding) => rules[id].findings.push(finding)
  const within = time => scope.windowStarted && time <= scope.asOf && dayAt(time, scope.timezone) >= scope.start
  const lateStart = shiftDay(scope.releaseDate, -4)
  const lateActive = scope.today >= lateStart
  const readinessActive = scope.daysRemaining <= 3 && (scope.daysRemaining >= 0 || !scope.version.released)
  const t2 = scope.daysRemaining >= 0 && scope.daysRemaining <= 2
  const regression = change => DEVELOPMENT.has(next(change)) &&
    (DONE.has(previous(change)) || (Number.isFinite(config.workflow?.[previous(change)]) &&
      Number.isFinite(config.workflow?.[next(change)]) &&
      config.workflow[previous(change)] > config.workflow[next(change)]))
  const commentIssues = []
  const commentCandidates = []
  const currentIds = new Set(data.current.map(issueId))
  const asOfIsPast = Boolean(config.replay)
  if (asOfIsPast) data.gap('clock', 'Live Jira fields reflect retrieval time. asOf only bounds historical events and date calculations.')

  for (const issue of data.candidates) {
    const { belonged, timeline } = membership(issue, data, scope)
    const ref = issueRef(scope, issue)
    const epic = issue.fields?.issuetype?.name === 'Epic'
    if (belonged && !issue.fields?.issuetype?.name) data.gap('history', issue.key + ': Issue type unavailable.')
    if (belonged && scope.windowStarted) commentIssues.push(issue)
    for (const { event, scopeChange, associated } of timeline) {
      if (event.created > scope.asOf) continue
      if (scopeChange) {
        const index = event.items.findIndex(change => fix(change) &&
          ids(scopeChange === 'Added' ? change.to : change.from).includes(scope.version.id))
        const finding = { issue: ref, type: scopeChange + (epic ? ' (Epic)' : ''),
          ...evidence(event, event.items[index], index) }
        if (within(event.created)) add('RV-01', finding)
        const day = dayAt(event.created, scope.timezone)
        if (scopeChange === 'Added' && lateActive && day >= lateStart && day <= scope.releaseDate) {
          add('HR-02', finding)
        }
      }
      if (!associated) continue
      for (const [index, change] of event.items.entries()) {
        const estimate = Boolean(data.points && change.fieldId === data.points)
        const ev = { issue: ref, ...evidence(event, change, index) }
        if (epic && (fix(change) || estimate || status(change))) add('HR-01', ev)
        if (!within(event.created)) continue
        if (estimate) {
          const before = ev.previous == null || ev.previous === '' ? null : Number(ev.previous)
          const after = ev.next == null || ev.next === '' ? null : Number(ev.next)
          if ((before !== null && !Number.isFinite(before)) || (after !== null && !Number.isFinite(after))) {
            data.gap('sizing', issue.key + ': Invalid historical Story Points.')
          } else if (before !== after) {
            add('RV-02', { ...ev, previous: before, next: after, type: before === null ? 'Estimate Added'
              : after === null ? 'Estimate Removed' : after > before ? 'Increase' : 'Decrease' })
          }
        }
        if (status(change) && regression(change)) add('RV-03', ev)
      }
    }
  }

  const apps = new Map()
  const squads = new Map()
  let done = 0
  for (const issue of data.current) {
    const ref = issueRef(scope, issue)
    const currentEvidence = { issue: ref, timestamp: config.retrievedAt ?? scope.asOf }
    if (DONE.has(ref.status)) done++
    else if (ref.status) {
      add('RV-05', currentEvidence)
      if (readinessActive) add('HR-03', { ...currentEvidence, overdue: scope.daysRemaining < 0 })
    }
    if (ref.status === 'On Hold') add('RV-04', { ...currentEvidence,
      type: 'On Hold', riskState: 'active', evidence: 'Current status is On Hold' })
    const values = eons(issue, data.eon)
    if (!values.length) data.gap('applications', issue.key + ': EON ID missing or unreadable.')
    for (const eon of values) {
      const group = apps.get(eon) ?? { eon, issues: new Map(), squads: new Map() }
      group.issues.set(ref.id, ref)
      for (const component of issue.fields?.components ?? []) {
        group.squads.set(String(component.id ?? component.name), component.name)
      }
      apps.set(eon, group)
    }
    for (const component of issue.fields?.components ?? []) {
      const id = String(component.id ?? component.name)
      const group = squads.get(id) ?? { squad: component.name, issues: new Map(), eons: new Set() }
      group.issues.set(ref.id, ref)
      for (const eon of values) group.eons.add(eon)
      squads.set(id, group)
    }
  }
  for (const eon of [...apps.keys()].sort()) {
    const group = apps.get(eon)
    const footprint = { eon, issues: [...group.issues.values()], squads: [...group.squads.values()].sort(),
      issueCount: group.issues.size, squadCount: group.squads.size }
    add('RD-01', footprint)
    if (footprint.squadCount > 1) {
      const ids = new Set(footprint.issues.map(issue => issue.id))
      const coordination = data.links.filter(link => ids.has(link.sourceId) && ids.has(link.linkedId))
        .map(link => ({ source: group.issues.get(link.sourceId), linked: group.issues.get(link.linkedId),
          type: link.type, direction: link.role }))
      add('RD-03', { ...footprint, coordination })
    }
  }
  if (squads.size > 1) for (const group of [...squads.values()].sort((a, b) => a.squad.localeCompare(b.squad))) {
    add('RD-02', { squad: group.squad, issues: [...group.issues.values()],
      issueCount: group.issues.size, eons: [...group.eons].sort() })
  }

  for (const issue of commentIssues) {
    await data.loadComments(issue)
    const candidates = []
    for (const comment of data.comments.get(issueId(issue)) ?? []) {
      if (!Number.isFinite(Date.parse(comment.created))) {
        data.gap('comments', issue.key + ': Invalid comment timestamp.')
        continue
      }
      const timestamp = new Date(comment.created).toISOString()
      if (!within(timestamp)) continue
      const text = textOf(comment.body)
      if (!text) data.gap('comments', issue.key + ': Comment body unreadable.')
      candidates.push({ id: String(comment.id), timestamp, text,
        candidate: /\b(block\w*|delay\w*|flag\w*|impediment\w*|waiting\s+(?:on|for))\b/i.test(text),
        actor: comment.author?.displayName ?? comment.author?.accountId ?? unavailable })
    }
    const candidateIds = new Set(candidates.filter(comment => comment.candidate).map(comment => comment.id))
    if (!candidateIds.size) continue
    if (currentIds.has(issueId(issue))) for (const comment of candidates.filter(item => candidateIds.has(item.id))) {
      commentCandidates.push({
        issue: issueRef(scope, issue), type: 'Possible impediment', timestamp: comment.timestamp,
        commentId: comment.id, commentUrl: url(scope, issue.key) + '?focusedCommentId=' + encodeURIComponent(comment.id)
      })
    }
    try {
      if (!judge) throw new Error('Comment judge is not configured.')
      const results = await judge({ issue: issueRef(scope, issue), comments: candidates })
      if (!Array.isArray(results) || results.length !== candidateIds.size ||
          new Set(results.map(item => item.id)).size !== candidateIds.size ||
          results.some(item => !candidateIds.has(item.id) || !['active', 'resolved', 'unknown'].includes(item.state))) {
        throw new Error('Comment judge returned invalid or incomplete classifications.')
      }
      const byComment = new Map(results.map(item => [item.id, item]))
      for (const comment of candidates.filter(item => candidateIds.has(item.id))) {
        const classification = byComment.get(comment.id)
        if (classification.relevant === false) continue
        const riskState = classification.state
        if (riskState === 'unknown') data.gap('comments', issue.key + ': Comment ' + comment.id + ' could not be classified.')
        if (riskState === 'active' || riskState === 'resolved') add('RV-04', {
          issue: issueRef(scope, issue), type: 'Documented impediment', riskState, evidence: comment.text,
          timestamp: comment.timestamp, actor: comment.actor, commentId: comment.id,
          commentUrl: url(scope, issue.key) + '?focusedCommentId=' + encodeURIComponent(comment.id)
        })
      }
    } catch (error) {
      data.gap('comments', issue.key + ': ' + error.message)
    }
  }

  const currentById = new Map(data.current.map(issue => [issueId(issue), issue]))
  const statusCategories = new Map()
  async function category(change, issue) {
    const id = change.to
    if (!id) {
      data.gap('linkedWorkflow', issue.key + ': Historical destination status ID unavailable.')
      return null
    }
    if (!statusCategories.has(id)) {
      try { statusCategories.set(id, (await jira.status(id)).statusCategory?.key ?? null) }
      catch { statusCategories.set(id, null) }
    }
    const result = statusCategories.get(id)
    if (!result) data.gap('linkedWorkflow', issue.key + ': Historical status category unavailable.')
    return result
  }
  for (const link of data.links) {
    const issue = data.linked.get(link.linkedId)
    const ref = issueRef(scope, issue)
    const linkedProject = issue.fields?.project?.id
    const linkedVersions = issue.fields?.fixVersions
    if (!ref.status || linkedProject == null) data.gap('linked', issue.key + ': Linked status or project unavailable.')
    const entry = { issue: issueRef(scope, currentById.get(link.sourceId)), linked: ref, direction: link.role,
      linkId: link.id, linkType: link.type, external: linkedProject == null ? null : String(linkedProject) !== scope.project.id,
      timestamp: config.retrievedAt ?? scope.asOf }
    if (link.role === 'upstream') {
      if (ref.status && !DONE.has(ref.status)) add('RD-08', entry)
      if (t2 && ref.status === 'In Progress') add('RD-06', entry)
      const versions = [...new Set((linkedVersions ?? []).map(version => String(version.id)))]
      if (versions.length === 1) await data.loadVersion(versions[0])
      const date = versions.length === 1 ? data.versions.get(versions[0])?.releaseDate : null
      if (!date) data.gap('timing', issue.key + ': Applicable upstream release date could not be established.')
      else if (date >= scope.releaseDate) add('RD-05', { ...entry, releaseDate: date,
        type: date === scope.releaseDate ? 'Same-day sequencing' : 'Upstream scheduled after downstream' })
    }
    if (!scope.windowStarted) continue
    await data.loadHistory(issue, 'linkedHistory')
    for (const event of events(issue, data, 'linkedHistory').filter(event => within(event.created))) {
      for (const [index, change] of event.items.entries()) {
        const finding = { ...entry, ...evidence(event, change, index) }
        if (fix(change)) {
          const before = ids(change.from)
          const after = ids(change.to)
          for (const id of new Set([...before, ...after])) await data.loadVersion(id)
          if ((change.fromString && !before.length) ||
              (typeof change.toString === 'string' && change.toString && !after.length)) {
            data.gap('dates', issue.key + ': Historical FixVersion IDs unavailable.')
          }
          const dates = list => list.map(id => ({ id, name: data.versions.get(id)?.name,
            releaseDate: data.versions.get(id)?.releaseDate ?? null }))
          const beforeDates = dates(before)
          const afterDates = dates(after)
          if ([...beforeDates, ...afterDates].some(version => !version.releaseDate)) {
            data.gap('dates', issue.key + ': Historical linked release date unavailable.')
          }
          add('RD-04', { ...finding, beforeDates, afterDates, timingRisk: link.role === 'upstream' &&
            afterDates.length === 1 && afterDates[0].releaseDate >= scope.releaseDate &&
            (beforeDates.length === 0 || (beforeDates.length === 1 && beforeDates[0].releaseDate &&
              afterDates[0].releaseDate >= beforeDates[0].releaseDate)) })
        }
        if (status(change) && DONE.has(previous(change)) && await category(change, issue) === 'indeterminate') {
          add('RD-07', finding)
        }
      }
    }
  }

  const datasets = {
    'HR-01': ['history', 'sizing'], 'HR-02': ['history'],
    'HR-03': ['current', 'readiness', 'clock'], 'RV-01': ['history'],
    'RV-02': ['history', 'sizing'], 'RV-03': ['history'],
    'RV-04': ['current', 'readiness', 'clock', ...(scope.windowStarted ? ['history', 'comments'] : [])],
    'RV-05': ['current', 'readiness', 'clock'], 'RD-01': ['current', 'applications', 'squads', 'clock'],
    'RD-02': ['current', 'squads', 'clock'], 'RD-03': ['current', 'applications', 'squads', 'clock'],
    'RD-04': ['current', 'links', 'linked', 'linkedHistory', 'dates'],
    'RD-05': ['current', 'links', 'linked', 'timing', 'clock'],
    'RD-06': ['current', 'links', 'linked', 'clock'],
    'RD-07': ['current', 'links', 'linked', 'linkedHistory', 'linkedWorkflow'],
    'RD-08': ['current', 'links', 'linked', 'clock']
  }
  const notApplicable = new Set([
    ...(!scope.windowStarted ? ['RV-01', 'RV-02', 'RV-03', 'RD-04', 'RD-07'] : []),
    ...(!lateActive ? ['HR-02'] : []), ...(!readinessActive ? ['HR-03'] : []), ...(!t2 ? ['RD-06'] : [])
  ])
  for (const rule of Object.values(rules)) {
    rule.gaps = notApplicable.has(rule.id) ? [] : [...new Set(datasets[rule.id].flatMap(
      dataset => [...(data.gaps[dataset] ?? [])]))].sort()
    rule.state = rule.findings.length ? 'Detected' : notApplicable.has(rule.id) ? 'Not Applicable'
      : rule.gaps.length ? 'Unable to Evaluate' : 'None Detected'
  }
  const atRisk = ['HR-01', 'HR-02', 'HR-03', 'RV-03', 'RV-05', 'RD-05', 'RD-06', 'RD-07', 'RD-08']
  const risks = atRisk.filter(id => rules[id].findings.length)
  if (rules['RD-04'].findings.some(finding => finding.timingRisk)) risks.push('RD-04')
  const watch = ['RV-01', 'RD-03'].filter(id => rules[id].findings.length)
  if (rules['RV-02'].findings.some(finding => finding.type === 'Increase')) watch.push('RV-02')
  if (rules['RV-04'].findings.some(finding => finding.riskState === 'active')) watch.push('RV-04')
  const incomplete = Object.values(rules).some(rule => rule.gaps.length)
  const additions = rules['RV-01'].findings.filter(item => item.type.startsWith('Added')).length
  const removals = rules['RV-01'].findings.length - additions
  data.commentCandidates = commentCandidates
  return {
    ruleVersion: '1.0.0', scope, rules,
    assessment: risks.length ? 'AT RISK' : watch.length || incomplete ? 'WATCH' : 'CLEAR',
    assessmentReasons: risks.length ? risks : watch,
    completeness: Object.fromEntries(Object.keys(datasets).flatMap(id => datasets[id]).sort()
      .map(dataset => [dataset, data.gaps[dataset]?.size ? 'partial' : 'complete'])),
    metrics: { additions, removals, net: additions - removals,
      affected: new Set(rules['RV-01'].findings.map(item => item.issue.id)).size,
      total: data.current.length, done, notDone: rules['RV-05'].findings.length, squads: squads.size,
      readiness: data.current.length && !rules['RV-05'].gaps.length ? 100 * done / data.current.length : null },
    configuration: { storyPoints: data.points ?? null, eon: data.eon, linkTypes: config.links ?? {},
      historicalStrategy: 'fleet candidate changelogs', retrievedAt: config.retrievedAt ?? scope.asOf }
  }
}
