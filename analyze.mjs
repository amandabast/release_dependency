import { jiraClient, configFromEnv, collect } from './jira.mjs'
import { resolveScope, InputError } from './scope.mjs'
import { evaluate, textOf } from './rules.mjs'
import { renderReport } from './report.mjs'
import { groupBlockedWork } from './blocked-work.mjs'

function evidenceService(url, token) {
  if (!url) return undefined
  return async evidence => {
    const response = await fetch(url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { 'content-type': 'application/json', ...(token && { authorization: 'Bearer ' + token }) },
      body: JSON.stringify(evidence)
    })
    if (!response.ok) throw new Error('Evidence service HTTP ' + response.status)
    return response.json()
  }
}

async function reviewContext(result, data, jira, annotateEvidence) {
  const findings = Object.values(result.rules).filter(rule => !['RD-01', 'RD-02', 'RV-05'].includes(rule.id))
    .flatMap(rule => rule.findings.map(finding => ({ ruleId: rule.id, finding })))
    .concat(data.commentCandidates.map(finding => ({ ruleId: 'RV-04', finding })))
    .map((entry, index) => {
      const id = String(index)
      entry.finding.contextId = id
      return { ...entry, id, issues: [entry.finding.issue, entry.finding.linked, ...(entry.finding.issues ?? [])]
        .filter(Boolean) }
    })
  const subjects = new Map(findings.flatMap(entry => entry.issues).map(issue => [issue.id, issue]))
  const sources = []
  const gaps = []
  for (const issue of subjects.values()) {
    try {
      const details = await jira.issue(issue.id, ['description'])
      if (!Object.hasOwn(details?.fields ?? {}, 'description')) throw new Error()
      const text = textOf(details.fields.description)
      if (text) sources.push({ id: issue.id + ':description', issueId: issue.id, type: 'description',
        text, url: issue.url })
      else if (details.fields.description != null) gaps.push({ issueId: issue.id, message: 'Description unreadable.' })
    } catch {
      gaps.push({ issueId: issue.id, message: 'Description unavailable.' })
    }
    await data.loadComments(issue)
    if (!data.commentCoverage.get(issue.id)) gaps.push({ issueId: issue.id, message: 'Comment retrieval incomplete.' })
    for (const comment of data.comments.get(issue.id) ?? []) {
      const timestamp = Date.parse(comment.created)
      if (!Number.isFinite(timestamp)) {
        gaps.push({ issueId: issue.id, message: 'A comment timestamp was unavailable.' })
        continue
      }
      if (timestamp > Date.parse(result.scope.asOf)) continue
      const text = textOf(comment.body)
      if (!text) {
        gaps.push({ issueId: issue.id, message: 'A comment body was unreadable.' })
        continue
      }
      sources.push({ id: issue.id + ':comment:' + comment.id, issueId: issue.id, type: 'comment',
        text, timestamp: comment.created, author: comment.author?.displayName,
        url: issue.url && issue.url + '?focusedCommentId=' + encodeURIComponent(comment.id) })
    }
  }
  const context = {
    status: !findings.length ? 'not_applicable' : annotateEvidence ? 'reviewed' : 'needs_review',
    findings: findings.map(({ id, ruleId, finding }) => ({ ...finding, annotationId: id, ruleId })),
    sources, gaps
  }
  if (!findings.length || !annotateEvidence) return context
  try {
    const annotations = await annotateEvidence({
      assessment: result.assessment, ...context
    })
    if (!Array.isArray(annotations?.reasons)) throw new Error('Invalid review response.')
    const byFinding = new Map(findings.map(entry => [entry.id, entry]))
    const bySource = new Map(sources.map(source => [source.id, source]))
    for (const entry of annotations.reasons) {
      const match = byFinding.get(entry?.annotationId)
      const source = bySource.get(entry?.sourceId)
      if (!match || !source || !match.issues.some(issue => source.issueId === issue.id) ||
          typeof entry.quote !== 'string' || !entry.quote.trim() || !source.text.includes(entry.quote)) {
        context.status = 'needs_review'
        continue
      }
      match.finding.reason = entry.quote
      match.finding.reasonSource = source.url
    }
  } catch {
    context.status = 'needs_review'
  }
  return context
}

export async function analyze(input, options = {}) {
  const env = options.env ?? process.env
  try {
    const config = options.config ?? configFromEnv(env)
    const jira = options.jira ?? jiraClient(config)
    const retrievedAt = options.retrievedAt ?? new Date().toISOString()
    const scope = await resolveScope({ ...input, asOf: input?.asOf ?? retrievedAt }, jira, config)
    const data = await collect(jira, scope, config)
    const result = await evaluate(scope, data, jira, {
      ...config, retrievedAt, replay: Boolean(input?.asOf && scope.asOf !== retrievedAt)
    }, options.judge ?? evidenceService(env.COMMENT_JUDGE_URL, env.COMMENT_JUDGE_TOKEN))
    result.contextReview = await reviewContext(result, data, jira,
      options.annotate ?? evidenceService(env.REASON_ANNOTATOR_URL, env.REASON_ANNOTATOR_TOKEN))
    result.blockedWork = groupBlockedWork(result, data.commentCandidates)
    return { status: 'ok', ...result, report: renderReport(result) }
  } catch (error) {
    if (error instanceof InputError) return {
      status: error.choices.length ? 'clarification_required' : 'invalid_input',
      message: error.message, choices: error.choices
    }
    return { status: 'error', message: error.message }
  }
}
