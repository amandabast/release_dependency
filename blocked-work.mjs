// A bucket explains what triggered review. Its kind describes what the source establishes.
const buckets = [
  { id: 'on_hold', label: 'Jira status is On Hold', kind: 'observed_status',
    rule: 'RV-04', matches: finding => finding.type === 'On Hold' },
  { id: 'unfinished_upstream', label: 'Upstream work is not Done', kind: 'dependency_risk', rule: 'RD-08' },
  { id: 'upstream_in_progress_at_t2', label: 'Upstream work is In Progress at T-2',
    kind: 'dependency_risk', rule: 'RD-06' },
  { id: 'upstream_release_timing', label: 'Upstream release is scheduled on or after the target release',
    kind: 'dependency_risk', rule: 'RD-05' },
  { id: 'upstream_release_changed', label: 'Upstream release assignment changed and presents a timing risk',
    kind: 'dependency_risk', rule: 'RD-04', matches: finding => finding.timingRisk },
  { id: 'linked_work_reopened', label: 'Linked work reopened', kind: 'dependency_risk', rule: 'RD-07' },
  { id: 'comment_needs_review', label: 'Jira comment mentions a possible impediment',
    kind: 'needs_judgment', rule: 'RV-04' }
]

export function groupBlockedWork(result, commentCandidates) {
  const byIssue = new Map()
  for (const { rule, matches, ...bucket } of buckets) {
    const findings = bucket.id === 'comment_needs_review' ? commentCandidates : result.rules[rule].findings
    for (const finding of findings) {
      if (matches && !matches(finding)) continue
      const item = byIssue.get(finding.issue.id) ?? { workItem: finding.issue, buckets: new Map() }
      const group = item.buckets.get(bucket.id) ?? { ...bucket, ruleId: rule, signals: [] }
      group.signals.push({
        contextId: finding.contextId,
        linkedWorkItem: finding.linked,
        linkId: finding.linkId,
        linkType: finding.linkType,
        direction: finding.direction,
        external: finding.external,
        linkedReleaseDate: finding.releaseDate,
        timestamp: finding.timestamp,
        commentId: finding.commentId,
        evidenceUrl: finding.commentUrl ?? finding.linked?.url ?? finding.issue.url
      })
      item.buckets.set(bucket.id, group)
      byIssue.set(finding.issue.id, item)
    }
  }
  return [...byIssue.values()].map(({ workItem, buckets }) => ({ workItem, buckets: [...buckets.values()] }))
    .sort((a, b) => a.workItem.key.localeCompare(b.workItem.key, 'en', { numeric: true }))
}
