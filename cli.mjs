import { analyze } from './analyze.mjs'

let result
try {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  result = await analyze(JSON.parse(Buffer.concat(chunks).toString('utf8')))
} catch {
  result = { status: 'invalid_input', message: 'Expected one JSON request on standard input.' }
}
console.log(JSON.stringify(result))
process.exitCode = result.status === 'error' ? 1 : 0
