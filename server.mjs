import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { analyze } from './analyze.mjs'

const token = process.env.ANALYSIS_API_TOKEN
if (!token) throw new Error('Set ANALYSIS_API_TOKEN before starting the server.')
const expected = Buffer.from('Bearer ' + token)
const host = process.env.ANALYSIS_HOST ?? '127.0.0.1'
const port = Number(process.env.PORT ?? 8080)
const server = createServer(async (request, response) => {
  const send = (code, result) => {
    response.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' })
    response.end(JSON.stringify(result))
  }
  if (request.url !== '/analyze' || request.method !== 'POST') {
    return send(404, { status: 'error', message: 'Use POST /analyze.' })
  }
  const supplied = Buffer.from(request.headers.authorization ?? '')
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    return send(401, { status: 'error', message: 'Unauthorized.' })
  }
  const chunks = []
  let length = 0
  try {
    for await (const chunk of request.iterator({ destroyOnReturn: false })) {
      length += chunk.length
      if (length > 16384) {
        response.setHeader('connection', 'close')
        return send(413, { status: 'invalid_input', message: 'Request is too large.' })
      }
      chunks.push(chunk)
    }
    const result = await analyze(JSON.parse(Buffer.concat(chunks).toString('utf8')))
    send(result.status === 'error' ? 502 : 200, result)
  } catch {
    send(400, { status: 'invalid_input', message: 'Expected a JSON request body.' })
  }
})
server.listen(port, host, () => console.error(`Listening on http://${host}:${port}/analyze`))
