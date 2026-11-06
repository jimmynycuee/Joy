// Stands in for `codex app-server`; all messages are synthetic and no model is invoked.
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const args = process.argv.slice(2)
if (args[0] !== 'app-server') {
  if (process.env.FAKE_EXEC_ARGS_OUT) writeFileSync(process.env.FAKE_EXEC_ARGS_OUT, JSON.stringify(args))
  if (process.env.FAKE_EXEC_REPLAY) process.stdout.write(readFileSync(process.env.FAKE_EXEC_REPLAY, 'utf8'))
  process.exit(0)
}

if (process.env.FAKE_APP_SERVER_MODE === 'exit') process.exit(2)
if (process.env.FAKE_APP_SERVER_MODE === 'hang') {
  setInterval(() => {}, 1000)
}

const fixture = JSON.parse(process.env.FAKE_APP_SERVER_FIXTURE ?? '{}')
const requestsPath = process.env.FAKE_RPC_OUT
const approvalsPath = process.env.FAKE_APPROVALS_OUT
const approvals = new Set()
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function record(path, value) {
  if (path) appendFileSync(path, `${JSON.stringify(value)}\n`)
}

function streamTurn() {
  send({
    id: 'command-approval',
    method: fixture.commandApproval.method,
    params: fixture.commandApproval.params,
  })
  send({ id: 'file-approval', method: fixture.fileApproval.method, params: fixture.fileApproval.params })
}

lines.on('line', (line) => {
  if (process.env.FAKE_APP_SERVER_MODE === 'hang') return
  const message = JSON.parse(line)
  record(requestsPath, message)
  if (message.method === 'initialize') {
    send({
      id: message.id,
      result: {
        userAgent: 'synthetic-codex',
        codexHome: '/tmp/codex',
        platformFamily: 'unix',
        platformOs: 'linux',
      },
    })
    return
  }
  if (message.method === 'initialized') return
  if (message.method === 'thread/start' || message.method === 'thread/resume') {
    send({ method: 'thread/started', params: { thread: fixture.thread } })
    send({ id: message.id, result: { thread: fixture.thread } })
    return
  }
  if (message.method === 'account/rateLimits/read') {
    send({ id: message.id, result: fixture.rateLimits })
    return
  }
  if (message.method === 'turn/start') {
    send({ id: message.id, result: { turn: { id: 'turn-synthetic-1' } } })
    streamTurn()
    return
  }
  if (message.id === 'command-approval' || message.id === 'file-approval') {
    approvals.add(message.id)
    record(approvalsPath, { id: message.id, result: message.result })
    if (approvals.size === 2) for (const notification of fixture.notifications) send(notification)
  }
})
