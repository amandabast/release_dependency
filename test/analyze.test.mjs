import assert from 'node:assert/strict'
import test from 'node:test'
import { analyze } from '../analyze.mjs'
import { jiraClient } from '../jira.mjs'

const date = '2026-12-18'
const asOf = '2026-12-16T19:00:00.000Z'
const target = { id: '100', name: 'December', releaseDate: date }
const points = 'customfield_12345'
const eon = 'customfield_13756'
const request = { fleet: 'FLEET', release: '100', timeframe: 'release_week' }
const page = (values, complete = true) => ({ values, complete })
function issue(id, extra = {}) {
  return { id, key: 'FLEET-' + id, fields: {
    project: { id: '1' }, status: { name: 'Closed' }, issuetype: { name: 'Story' },
    fixVersions: [target], components: [{ id: 'a', name: 'One' }], [eon]: ['EON-1'],
    issuelinks: [], summary: 'Example', ...extra
  } }
}
const event = (id, day, ...items) => ({ id, created: day + 'T15:00:00Z', items })
const fix = (from, to) => ({ field: 'Fix Version', from, to })
const sizing = (from, to) => ({ fieldId: points, from, to })
const status = (fromString, toString) => ({ fieldId: 'status', fromString, toString, to: '22' })
function fixture({ current = [], fleet = current, histories = {}, comments = {}, linked = {}, descriptions = {},
  versions = [target], dates = {}, verified = true, clock = asOf, judge, annotate } = {}) {
  const jira = {
    baseUrl: 'https://jira.example.org',
    project: async () => ({ id: '1', key: 'FLEET', name: 'Fleet' }),
    versions: async () => versions,
    configuration: async () => [{ id: points, schema: { type: 'number' } }],
    search: async jql => page(jql.includes('fixVersion') ? current : fleet),
    history: async id => histories[id] ?? page([]),
    comments: async id => comments[id] ?? page([]),
    issue: async (id, fields) => fields[0] === 'description' ?
      { fields: { description: descriptions[id] ?? null } } : linked[id],
    version: async id => dates[id],
    status: async () => ({ statusCategory: { key: 'indeterminate' } })
  }
  return input => analyze({ ...request, ...input }, { jira, judge, annotate, retrievedAt: clock,
    config: { timezone: 'America/Chicago', points, verifiedFleetCoverage: verified } })
}

test('removed and re-added work, membership-time sizing, and older Epic changes', async () => {
  const removed = issue('1', { fixVersions: [], issuetype: { name: 'Epic' } })
  const run = fixture({ fleet: [removed], histories: { 1: page([
    event('1', '2026-11-11', fix(null, '100')),
    event('2', '2026-11-12', sizing('1', '2')),
    event('3', '2026-12-11', fix('100', null)),
    event('4', '2026-12-12', sizing('2', '9')),
    event('5', '2026-12-13', fix(null, '100')),
    event('6', '2026-12-14', sizing('9', '10')),
    event('7', '2026-12-15', fix('100', null)),
    event('7', '2026-12-15', fix('100', null))
  ]) } })
  const result = await run()
  assert.equal(result.status, 'ok', result.message)
  assert.deepEqual(result.rules['RV-01'].findings.map(f => f.type), ['Removed (Epic)', 'Added (Epic)', 'Removed (Epic)'])
  assert.deepEqual(result.rules['RV-02'].findings.map(f => f.eventId), ['6'],
    JSON.stringify({ rule: result.rules['RV-02'], configuration: result.configuration }))
  assert.equal(result.rules['HR-01'].findings.length, 6)
  assert.equal(result.metrics.net, -1)
  assert.equal(result.metrics.readiness, null)
  assert.equal(result.assessment, 'AT RISK')
  assert.deepEqual(await run(), result)
})

test('partial changelogs preserve explicit events and prevent a Clear result', async () => {
  const current = [issue('1')]
  const partial = await fixture({ current, histories: { 1: page([], false) } })()
  assert.equal(partial.rules['RV-01'].state, 'Unable to Evaluate')
  assert.equal(partial.assessment, 'WATCH')
  const detected = await fixture({ current, histories: {
    1: page([event('1', '2026-12-14', fix(null, '100'))], false)
  } })()
  assert.equal(detected.rules['HR-02'].state, 'Detected')
  assert.ok(detected.rules['HR-02'].gaps.length)
  assert.equal(detected.assessment, 'AT RISK')
})

test('direct link direction, external links, ambiguous versions, and deduplicated footprint', async () => {
  const blocks = { id: '10', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' }
  const current = [issue('1', { [eon]: ['EON-1', 'EON-1', 'EON-2'], issuelinks: [
    { id: '1', type: blocks, inwardIssue: { id: '3' } },
    { id: '2', type: blocks, outwardIssue: { id: '4' } },
    { id: '3', type: { outward: 'relates to' }, outwardIssue: { id: '5' } }
  ] }), issue('2', { components: [{ id: 'b', name: 'Two' }] })]
  const linked = Object.fromEntries(['3', '4', '5'].map(id => [id, issue(id, {
    project: { id: '2' }, status: { name: 'In Progress' }, fixVersions: [{ id: '200' }]
  })]))
  const histories = { 3: page([event('1', '2026-12-14', fix('100', '200'),
    status('Closed', 'Developing'))]) }
  const same = await fixture({ current, linked, histories, dates: { 200: { releaseDate: date } } })()
  assert.equal(same.status, 'ok', same.message)
  assert.equal(same.rules['RD-05'].findings[0].type, 'Same-day sequencing')
  for (const id of ['RD-06', 'RD-07', 'RD-08']) {
    assert.deepEqual(same.rules[id].findings.map(f => [f.linked.id, f.external]), [['3', true]])
  }
  assert.equal(same.rules['RD-03'].findings[0].issueCount, 2)
  assert.equal(same.rules['RD-03'].findings[0].squadCount, 2)
  assert.match(same.report, /External/)
  linked['3'].fields.fixVersions.push(target)
  const ambiguous = await fixture({ current, linked })()
  assert.equal(ambiguous.rules['RD-05'].state, 'Unable to Evaluate')
})

test('calendar cutoffs, release selection, and overdue readiness', async () => {
  const current = [issue('1', { status: { name: 'In Progress' } })]
  const histories = { 1: page([
    event('1', '2026-12-13', fix(null, '100')),
    event('2', '2026-12-14', fix(null, '100')),
    event('3', '2026-12-18', fix(null, '100')),
    event('4', '2026-12-19', fix(null, '100'))
  ]) }
  const early = await fixture({ current, clock: '2026-12-10T19:00:00.000Z' })()
  assert.equal(early.rules['RV-01'].state, 'Not Applicable')
  assert.equal(early.rules['HR-02'].state, 'Not Applicable')
  assert.equal(early.rules['HR-03'].state, 'Not Applicable')
  assert.equal(early.assessment, 'AT RISK')
  const overdue = await fixture({ current, histories, clock: '2026-12-20T19:00:00.000Z' })()
  assert.deepEqual(overdue.rules['HR-02'].findings.map(f => f.eventId), ['2', '3'])
  assert.equal(overdue.rules['HR-03'].findings[0].overdue, true)
  const tie = await fixture({ versions: [target, { ...target, id: '101' }] })({ release: 'next' })
  assert.equal(tie.status, 'clarification_required')
  assert.equal(tie.choices.length, 2)
  const undated = await fixture({ versions: [{ ...target, releaseDate: null }] })()
  assert.equal(undated.status, 'invalid_input')
})

test('resolved and negated comments stay out of active risk and invalid evidence creates a gap', async () => {
  const current = [issue('1')]
  const comments = { 1: page([
    { id: '1', created: '2026-12-15T00:00:00Z', body: 'The blocker has been resolved.' },
    { id: '2', created: '2026-12-15T00:00:00Z', body: 'We are not blocked.' }
  ]) }
  const checked = await fixture({ current, comments, judge: async () => [
    { id: '1', state: 'resolved' }, { id: '2', state: 'unknown', relevant: false }
  ] })()
  assert.deepEqual(checked.rules['RV-04'].findings.map(f => f.riskState), ['resolved'])
  assert.equal(checked.assessment, 'CLEAR')
  const invalid = await fixture({ current, comments,
    judge: async () => [{ id: 'made-up', state: 'active' }] })()
  assert.equal(invalid.rules['RV-04'].state, 'Unable to Evaluate')
  assert.equal(invalid.assessment, 'WATCH')
})

test('Jira search follows page tokens and retains results after later-page failure', async () => {
  const calls = []
  const jira = jiraClient({ baseUrl: 'https://jira.example.org', email: 'test', token: 'test' },
    async (url, options) => {
      assert.equal(url.pathname, '/rest/api/3/search/jql')
      calls.push(JSON.parse(options.body))
      return calls.length === 1 ? Response.json({ issues: [issue('1')], nextPageToken: 'next' })
        : new Response('', { status: 403 })
    })
  const search = await jira.search('project = "1"', ['status'])
  assert.equal(search.complete, false)
  assert.equal(search.values.length, 1)
  assert.equal(calls[1].nextPageToken, 'next')
})

test('AI context includes ordinary scope comments and both sides of a blocking link', async () => {
  const current = [issue('1', { issuelinks: [
    { id: '1', type: { name: 'Blocks', inward: 'is blocked by' }, inwardIssue: { id: '2' } }
  ] })]
  const quote = 'Moved into December to meet the signed customer commitment.'
  const inputs = { current, linked: { 2: issue('2', { status: { name: 'In Progress' } }) },
    histories: { 1: page([event('1', '2026-12-15', fix(null, '100'))]) },
    descriptions: { 2: 'This supplies the migration schema required by FLEET-1.' },
    comments: { 1: page([{ id: '8', body: quote, created: '2026-12-15T19:00:00Z' }]) } }
  const pending = await fixture(inputs)()
  assert.equal(pending.contextReview.status, 'needs_review')
  assert.equal(pending.contextReview.sources.length, 2)
  const reviewed = await fixture({ ...inputs, annotate: async ({ findings }) => ({
    reasons: [
      { annotationId: findings.find(f => f.ruleId === 'RV-01').annotationId, sourceId: '1:comment:8', quote },
      { annotationId: findings.find(f => f.ruleId === 'RD-08').annotationId, sourceId: '2:description',
        quote: inputs.descriptions[2] }
    ]
  }) })()
  assert.equal(reviewed.contextReview.status, 'reviewed')
  assert.equal(reviewed.rules['RV-01'].findings[0].reason, quote)
  assert.match(reviewed.report, /focusedCommentId=8/)
  assert.match(reviewed.report, /supplies the migration schema/)
  assert.equal(reviewed.assessment, pending.assessment)
})

test('blocked work retains multiple deterministic buckets and sends comment candidates to AI', async () => {
  const current = [issue('1', { status: { name: 'On Hold' }, issuelinks: [
    { id: '9', type: { name: 'Blocks', inward: 'is blocked by' }, inwardIssue: { id: '2' } }
  ] }), issue('3', { status: { name: 'In Progress' } })]
  const result = await fixture({ current, linked: { 2: issue('2', {
    status: { name: 'In Progress' }, fixVersions: [{ id: '200' }]
  }) }, dates: { 200: { releaseDate: date } }, comments: { 1: page([
    { id: '5', created: asOf, body: 'We are not blocked.' }
  ]) } })()
  assert.equal(result.status, 'ok', result.message)
  assert.deepEqual(result.blockedWork.map(item => item.workItem.key), ['FLEET-1'])
  const { buckets } = result.blockedWork[0]
  assert.deepEqual(buckets.map(bucket => bucket.id), ['on_hold', 'unfinished_upstream',
    'upstream_in_progress_at_t2', 'upstream_release_timing', 'comment_needs_review'])
  assert.equal(buckets[1].signals[0].linkedWorkItem.key, 'FLEET-2')
  const candidate = buckets.at(-1)
  assert.equal(candidate.kind, 'needs_judgment')
  assert.ok(result.contextReview.findings.some(finding => finding.contextId === candidate.signals[0].contextId))
  assert.ok(result.contextReview.sources.some(source => source.id === '1:comment:5'))
  assert.equal(result.rules['RV-04'].findings.length, 1)
})
