#!/usr/bin/env node
// Minimal chromium-cli-style REPL for driving the Prompt Enhancer dev server.
// Reads commands from stdin, one per line, and executes them against a
// persistent headless Chromium page. Works both piped (heredoc, closes at
// EOF) and under tmux send-keys (stays open until `quit`).
//
// Commands:
//   nav <url>                    goto a URL
//   wait-for text=<text>         wait for an element containing text
//   wait-for <selector>          wait for a CSS selector
//   click <selector>             click (selector may be any Playwright
//                                 selector, e.g. button:has-text("Admin"))
//   fill <selector> <text...>    fill an input/textarea
//   press <key>                  press a key (e.g. Enter)
//   value <selector>             print inputValue() of a field
//   text <selector>              print innerText() of an element
//   eval <js>                    page.evaluate(js) and print the result
//   screenshot [name]            save PNG under screenshots/, print path
//   console                      print collected console messages
//   console --errors             print only console.error / pageerror
//   quit                         close the browser and exit
//
// Usage:
//   node driver.mjs <<'EOF'
//   nav http://localhost:5173
//   wait-for text=Prompt Enhancer
//   screenshot home
//   EOF

import { chromium } from 'playwright'
import readline from 'node:readline'
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SKILL_DIR = path.dirname(fileURLToPath(import.meta.url))
const SHOTS_DIR = path.join(SKILL_DIR, 'screenshots')
mkdirSync(SHOTS_DIR, { recursive: true })

const consoleLog = []
const browser = await chromium.launch({ args: ['--no-sandbox'] })
const page = await browser.newPage()
page.on('console', msg => consoleLog.push({ type: msg.type(), text: msg.text() }))
page.on('pageerror', err => consoleLog.push({ type: 'pageerror', text: String(err) }))

const splitOne = (s) => {
  const i = s.indexOf(' ')
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
}

async function handle(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return
  const [cmd, rest] = splitOne(trimmed)

  if (cmd === 'nav') {
    await page.goto(rest, { waitUntil: 'networkidle' })
    console.log(`OK nav ${rest}`)
  } else if (cmd === 'wait-for') {
    const sel = rest.startsWith('text=') ? `text=${rest.slice(5)}` : rest
    await page.waitForSelector(sel, { timeout: 30000 })
    console.log(`OK wait-for ${rest}`)
  } else if (cmd === 'click') {
    await page.click(rest)
    console.log(`OK click ${rest}`)
  } else if (cmd === 'fill') {
    const [sel, value] = splitOne(rest)
    await page.fill(sel, value)
    console.log(`OK fill ${sel}`)
  } else if (cmd === 'press') {
    await page.keyboard.press(rest)
    console.log(`OK press ${rest}`)
  } else if (cmd === 'value') {
    const v = await page.locator(rest).first().inputValue()
    console.log(v)
  } else if (cmd === 'text') {
    const v = await page.locator(rest).first().innerText()
    console.log(v)
  } else if (cmd === 'eval') {
    const v = await page.evaluate(rest)
    console.log(JSON.stringify(v))
  } else if (cmd === 'screenshot') {
    const name = rest.trim() || `shot-${Date.now()}`
    const file = path.join(SHOTS_DIR, `${name}.png`)
    await page.screenshot({ path: file, fullPage: true })
    console.log(`OK screenshot ${file}`)
  } else if (cmd === 'console') {
    const items = rest.trim() === '--errors'
      ? consoleLog.filter(m => m.type === 'error' || m.type === 'pageerror')
      : consoleLog
    console.log(items.length ? JSON.stringify(items, null, 2) : '(none)')
  } else if (cmd === 'quit') {
    await browser.close()
    process.exit(0)
  } else {
    console.log(`ERROR unknown command: ${cmd}`)
  }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })
for await (const line of rl) {
  try {
    await handle(line)
  } catch (e) {
    console.log(`ERROR ${e.message}`)
  }
}
await browser.close()
