import { currentQuery } from './jira.mjs'

const clean = value => String(value ?? 'Unavailable').replaceAll('\r', '').replaceAll('\n', ' ')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replace(/[\\|`*_[\]]/g, '\\$&')
const link = (label, url) => url ? '[' + clean(label) + '](<' + url + '>)' : clean(label)
const item = issue => link(issue?.key, issue?.url)
const items = issues => issues.map(item).join(', ')
const values = list => list?.length ? list.map(clean).join(', ') : 'Unavailable'
const table = (headers, rows) => ['| ' + headers.join(' | ') + ' |',
  '| ' + headers.map(() => '---').join(' | ') + ' |',
  ...rows.map(row => '| ' + row.join(' | ') + ' |')].join('\n')

export function renderReport(result) {
  const { scope, rules, metrics, configuration } = result
  const section = (id, headers, row) => {
    const rule = rules[id]
    return '### ' + rule.name + '\n\n' +
      (rule.findings.length ? table(headers, rule.findings.map(row)) : rule.state)
  }
  const gaps = Object.values(rules).flatMap(rule => rule.gaps.map(gap =>
    [rule.id, clean(gap), 'Evaluation incomplete']))
  const summary = result.assessmentReasons.length
    ? 'Assessment driven by ' + result.assessmentReasons.map(id => rules[id].name).join(', ') + '.'
    : result.assessment === 'CLEAR' ? 'All required and applicable checks completed without a risk signal.'
      : 'Material data gaps limit the assessment.'
  const jql = currentQuery(scope) + ' AND status NOT IN ("Ready for PRD", "Closed")'
  const linkRules = ['RD-04', 'RD-05', 'RD-06', 'RD-07', 'RD-08']
  const dateDetails = versions => versions?.map(version =>
    (version.name ?? version.id) + ' (' + (version.releaseDate ?? 'Unavailable') + ')').join(', ')
  const reason = finding => link(finding.reason ?? 'Reason Not Documented', finding.reasonSource)
  const linkedRows = linkRules.flatMap(id => rules[id].findings.map(f => [
    item(f.issue), item(f.linked) + (f.external ? ' (External)' : ''),
    clean(f.direction + (f.linkType ? ' / ' + f.linkType : '')), rules[id].name,
    clean(f.linked.status), clean(f.releaseDate ?? dateDetails(f.afterDates)),
    clean(f.type ?? (f.eventId ? [f.previous, f.next, f.timestamp, f.actor,
      dateDetails(f.beforeDates), dateDetails(f.afterDates)].filter(Boolean).join(' / ') : f.timestamp)) +
      (f.timingRisk ? ' (Timing risk)' : '') + (f.reasonSource ? ' / ' + reason(f) : '')
  ]))
  const changeRow = f => [item(f.issue), clean(f.previous), clean(f.next), clean(f.timestamp),
    clean(f.actor), reason(f)]
  const parts = [
    '# Release Scope & Dependency Report',
    `**Fleet:** ${clean(scope.project.name)} (${clean(scope.project.key)})\n\n**Release:** ${clean(scope.version.name)}\n\n` +
      `**Release Date:** ${scope.releaseDate}\n\n**Days Remaining:** ${scope.daysRemaining}\n\n` +
      `**Analysis Window:** ${clean(scope.timeframe)} (${scope.start} → ${scope.asOf})\n\n` +
      `**Data As Of:** ${configuration.retrievedAt} (${clean(scope.timezone)})`,
    '## Overall Assessment\n\n**Assessment:** ' + result.assessment + '\n\n' + summary +
      (gaps.length ? ' See Data Gaps for checks that could not be fully verified.' : ''),
    '## High-Risk Changes',
    section('HR-01', ['Work Item', 'Change', 'Previous Value', 'New Value', 'Timestamp', 'Actor', 'Documented Reason'],
      f => [item(f.issue), clean(f.field), ...changeRow(f).slice(1)]),
    section('HR-02', ['Work Item', 'Summary', 'Squad', 'Date Added', 'Actor', 'Current Status'],
      f => [item(f.issue), clean(f.issue.summary), values(f.issue.squads), clean(f.timestamp),
        clean(f.actor), clean(f.issue.status)]),
    section('HR-03', ['Work Item', 'Summary', 'Squad', 'Current Status', 'Days Remaining'],
      f => [item(f.issue), clean(f.issue.summary), values(f.issue.squads), clean(f.issue.status),
        scope.daysRemaining + (f.overdue ? ' (Overdue, unreleased)' : '')]),
    '## Release Volatility',
    section('RV-01', ['Work Item', 'Summary', 'Change Type', 'Timestamp', 'Actor', 'Documented Reason'],
      f => [item(f.issue), clean(f.issue.summary), clean(f.type), clean(f.timestamp), clean(f.actor), reason(f)]) +
      '\n\n' + `Addition events: ${metrics.additions}. Removal events: ${metrics.removals}. ` +
      `Unique affected issues: ${metrics.affected}. Net change: ${metrics.net}.` +
      (rules['RV-01'].gaps.length ? ' Counts reflect retrieved evidence.' : ''),
    section('RV-02', ['Work Item', 'Previous Estimate', 'New Estimate', 'Change Type', 'Timestamp', 'Actor', 'Documented Reason'],
      f => [item(f.issue), clean(f.previous ?? 'Unestimated'), clean(f.next ?? 'Unestimated'), clean(f.type), ...changeRow(f).slice(3)]),
    section('RV-03', ['Work Item', 'Previous Status', 'New Status', 'Timestamp', 'Actor', 'Documented Reason'], changeRow),
    section('RV-04', ['Work Item', 'Current Status', 'Impediment', 'Risk State', 'Evidence', 'Timestamp', 'Actor'],
      f => [item(f.issue), clean(f.issue.status), clean(f.type), clean(f.riskState),
        link(f.evidence, f.commentUrl), clean(f.timestamp), clean(f.actor)]),
    '### Readiness\n\n' + (rules['RV-05'].findings.length ? '' : rules['RV-05'].state + '\n\n') +
      `- Total work items: ${metrics.total}\n- Done: ${metrics.done}\n- Not Done: ${metrics.notDone}\n` +
      `- Readiness: ${metrics.readiness === null ? 'Unavailable' : metrics.readiness.toFixed(1) + '%'}\n\n` +
      '**Work items not yet Done:** ' + link('Open Jira search', scope.baseUrl + '/issues/?jql=' + encodeURIComponent(jql)),
    '## Release Dependency Mapping',
    section('RD-01', ['EON ID', 'Associated Work Items', 'Squads', 'Work Item Count', 'Squad Count'],
      f => [clean(f.eon), items(f.issues), values(f.squads), f.issueCount, f.squadCount]),
    section('RD-02', ['Squad', 'Associated Work Items', 'Work Item Count', 'EON IDs'],
      f => [clean(f.squad), items(f.issues), f.issueCount, values(f.eons)]) +
      '\n\n**Participating Squads:** ' + metrics.squads,
    section('RD-03', ['EON ID', 'Participating Squads', 'Associated Work Items', 'Coordination Evidence'],
      f => [clean(f.eon), values(f.squads), items(f.issues), f.coordination.length ?
        f.coordination.map(edge => item(edge.source) + ' → ' + item(edge.linked) + ' (' + clean(edge.type) + ')').join(', ')
        : 'None retrieved']),
    '### At-Risk Links\n\n' + (linkedRows.length ? table(['Release Work Item', 'Linked Work Item',
      'Link Direction', 'Signal', 'Linked Status', 'Linked Release Date', 'Evidence'], linkedRows) + '\n\n' : '') +
      linkRules.filter(id => !rules[id].findings.length).map(id => '- ' + rules[id].name + ': ' + rules[id].state).join('\n'),
    ...(result.contextReview?.findings.length ? [
      '## Jira Work-Item Context\n\n' + (result.contextReview.status === 'needs_review'
        ? 'AI review is pending. The structured result includes Jira descriptions and comments for review.'
        : 'Documented reasons were reviewed against the retrieved Jira sources.') +
        (result.contextReview.gaps.length ? ' Some issue descriptions or comments were unavailable.' : ''),
      ...([...new Map(Object.values(rules).flatMap(rule => rule.findings).filter(finding => finding.reasonSource)
        .map(finding => [finding.issue.id + finding.reasonSource + finding.reason, finding])).values()]).map(
        finding => '- ' + item(finding.issue) + (finding.linked ? ' / ' + item(finding.linked) : '') + ' — ' + reason(finding))
    ] : []),
    '## Data Gaps\n\n' + (gaps.length ? table(['Affected Rule', 'Missing or Incomplete Data',
      'Impact on Analysis'], gaps) : 'None Detected'),
    '## Configuration Notes\n\n' + `- Timezone: ${clean(scope.timezone)}\n` +
      `- Story Points field: ${clean(configuration.storyPoints)}\n- EON ID field: ${clean(configuration.eon)}\n` +
      (Object.keys(configuration.linkTypes).length ? '- Link mappings: ' + clean(JSON.stringify(configuration.linkTypes)) + '\n' : '') +
      '- Historical retrieval: ' + clean(configuration.historicalStrategy) +
      (configuration.annotationNote ? '\n- ' + clean(configuration.annotationNote) : '')
  ]
  return parts.join('\n\n').trim() + '\n'
}
