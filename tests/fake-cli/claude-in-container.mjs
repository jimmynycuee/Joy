// A stand-in for `claude -p` used by the container e2e test (T4.5). It records what it can see from inside the
// container, then replays a recorded Claude stream so Joy's parser sees a normal run.
import { readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const args = process.argv.slice(2)
const prompt = args[args.indexOf('-p') + 1] ?? ''
const secretPath = /SECRET_PATH=(\S+)/.exec(prompt)?.[1]
let secretVisible = false
try {
  if (secretPath) secretVisible = readFileSync(secretPath, 'utf8').length > 0
} catch {
  secretVisible = false
}
let homeVisible = true
try {
  statSync(join('/root', '.ssh'))
} catch {
  homeVisible = false
}
writeFileSync(
  join(process.cwd(), 'container-proof.json'),
  JSON.stringify({
    secretVisible,
    homeVisible,
    home: process.env.HOME,
    uid: process.getuid?.(),
    cwd: process.cwd(),
  }),
)
const fixture = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'fixtures',
  'cli-events',
  'claude',
  'edit.jsonl',
)
process.stdout.write(readFileSync(fixture, 'utf8'))
