// `npm run dev` — run the history server and Vite together, tear both down as one.
import { spawn } from 'node:child_process'

const procs = [
  { name: 'api', cmd: process.execPath, args: ['server/index.mjs'] },
  { name: 'web', cmd: 'npx', args: ['vite'] },
]

const children = []
let shuttingDown = false

function killAll(signal = 'SIGTERM') {
  if (shuttingDown) return
  shuttingDown = true
  for (const c of children) { try { c.kill(signal) } catch { /* already gone */ } }
}

for (const { name, cmd, args } of procs) {
  const child = spawn(cmd, args, { stdio: ['inherit', 'inherit', 'inherit'], env: process.env, shell: process.platform === 'win32' })
  child.on('exit', (code, signal) => {
    if (shuttingDown) return
    console.log(`\n[dev] ${name} exited (${signal || code}) — stopping the other process`)
    killAll()
    process.exit(code == null ? 1 : code)
  })
  children.push(child)
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { killAll(sig); process.exit(0) })
