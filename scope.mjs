export class InputError extends Error {
  constructor(message, choices = []) {
    super(message)
    this.choices = choices
  }
}

export function dayAt(timestamp, timezone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(new Date(timestamp))
  const part = name => parts.find(entry => entry.type === name).value
  return [part('year'), part('month'), part('day')].join('-')
}

export const dayNumber = date => Date.parse(date + 'T00:00:00Z') / 86400000
export const shiftDay = (date, offset) =>
  new Date((dayNumber(date) + offset) * 86400000).toISOString().slice(0, 10)

function priorMonth(date) {
  const [year, month, day] = date.split('-').map(Number)
  const last = new Date(Date.UTC(year, month - 1, 0))
  last.setUTCDate(Math.min(day, last.getUTCDate()))
  return last.toISOString().slice(0, 10)
}

export async function resolveScope(input, jira, config) {
  if (!input || typeof input.fleet !== 'string' || !input.fleet.trim() ||
      !['string', 'number'].includes(typeof input.release) || !String(input.release).trim() ||
      !['month', 'two_weeks', 'release_week'].includes(input.timeframe)) {
    throw new InputError('Provide fleet, release, and timeframe (month, two_weeks, or release_week).')
  }
  const clock = new Date(input.asOf ?? Date.now())
  if (!Number.isFinite(clock.getTime()) || (input.asOf != null &&
      (typeof input.asOf !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/i.test(input.asOf)))) {
    throw new InputError('asOf must be an ISO timestamp with a timezone offset.')
  }
  const asOf = clock.toISOString()
  const project = await jira.project(input.fleet.trim())
  const versions = await jira.versions(project.id)
  let timezone = config.timezone
  if (!timezone) timezone = await jira.timezone().catch(() => 'UTC')
  const today = dayAt(asOf, timezone)
  const selector = String(input.release).trim()
  let choices
  if (selector === 'next') {
    const eligible = versions.filter(v => !v.released && !v.archived && v.releaseDate >= today)
    eligible.sort((a, b) => a.releaseDate.localeCompare(b.releaseDate) || String(a.id).localeCompare(String(b.id)))
    choices = eligible.filter(v => v.releaseDate === eligible[0]?.releaseDate)
  } else {
    const byId = versions.find(v => String(v.id) === selector)
    choices = byId ? [byId] : versions.filter(v => v.name === selector)
  }
  if (!choices.length) throw new InputError('No matching release was found in the fleet.')
  if (choices.length > 1) throw new InputError('Choose a release by its FixVersion ID.', choices.map(
    ({ id, name, releaseDate }) => ({ id, name, releaseDate })))
  const version = choices[0]
  const { releaseDate } = version
  if (!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate ?? '') || !Number.isFinite(dayNumber(releaseDate))) {
    throw new InputError('The selected FixVersion has no usable release date.')
  }
  const start = input.timeframe === 'month' ? priorMonth(releaseDate)
    : shiftDay(releaseDate, input.timeframe === 'two_weeks' ? -14 : -7)
  return {
    project: { id: String(project.id), key: project.key, name: project.name },
    version: { id: String(version.id), name: version.name, released: version.released === true },
    releaseDate, daysRemaining: dayNumber(releaseDate) - dayNumber(today), today,
    timeframe: input.timeframe, start, asOf, timezone, windowStarted: today >= start,
    baseUrl: jira.baseUrl
  }
}
