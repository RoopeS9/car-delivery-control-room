"use strict"
// R8: the process documents as B-roll for scene 5a. Renders PROCESS.md, the night's results and the review as clean pages,
// then glides to the passages that matter and highlights each one, holding long enough to read.
//   node r8-process.cjs [--focus "phrase one|phrase two"] [--docs "PROCESS.md|starter/scripts/night/MORNING.md"]
// The default passages are the ones the script talks about: the 5.9 s voice latency, the clock bug, the held stop instruction,
// and the review's verdict. To find a passage for another phrase, pass it in --focus: the page is searched for the text.

const fs = require("fs")
const path = require("path")
const lib = require("./lib.cjs")
const { ROOT, parseArgs, config, Run, sleep } = lib

const DEFAULTS = [
  { doc: "PROCESS.md", focus: ["5.9 s per turn", "Separated operator approval from customer agreement"] },
  { doc: "starter/scripts/night/MORNING.md", focus: ["The simulated clock restarted behind its own records", "A stop instruction was held as clearance"] },
  { doc: "REVIEW-BAHN.md", focus: ["Yes, we would pilot this"] },
]

const escapeHtml = (text) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
function inline(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<i>$2</i>")
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, "<u>$1</u>")
}

/** A small markdown renderer: headings, paragraphs, lists, tables, code fences, quotes. Enough for our own logs. */
function markdown(md) {
  const lines = md.replace(/\r/g, "").split("\n")
  const out = []
  let list = null, para = [], table = null, fence = false
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(" "))}</p>`); para = [] } }
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null } }
  const flushTable = () => { if (table) { out.push(renderTable(table)); table = null } }
  const cells = (row) => row.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim())
  const renderTable = (rows) => {
    const [head, , ...body] = rows
    return `<table><thead><tr>${cells(head).map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${cells(r).map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
  }
  for (const line of lines) {
    if (line.startsWith("```")) { flushPara(); flushList(); flushTable(); out.push(fence ? "</pre>" : "<pre>"); fence = !fence; continue }
    if (fence) { out.push(escapeHtml(line)); continue }
    if (/^\s*\|.*\|\s*$/.test(line)) { flushPara(); flushList(); (table ||= []).push(line); continue }
    flushTable()
    const heading = line.match(/^(#{1,4})\s+(.*)$/)
    const bullet = line.match(/^\s*[-*]\s+(.*)$/)
    const numbered = line.match(/^\s*\d+[.)]\s+(.*)$/)
    if (heading) { flushPara(); flushList(); out.push(`<h${heading[1].length}>${inline(heading[2])}</h${heading[1].length}>`) }
    else if (bullet || numbered) { flushPara(); const tag = bullet ? "ul" : "ol"; if (list !== tag) { flushList(); out.push(`<${tag}>`); list = tag } out.push(`<li>${inline((bullet || numbered)[1])}</li>`) }
    else if (/^>\s?/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ""))}</blockquote>`) }
    else if (!line.trim()) { flushPara(); flushList() }
    else if (/^\s{2,}\S/.test(line) && list) out.push(inline(line.trim()) + " ")
    else { flushList(); para.push(line.trim()) }
  }
  flushPara(); flushList(); flushTable()
  return out.join("\n")
}

const PAGE = (title, body) => `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600&family=Unbounded:wght@700&display=swap">
<style>
  body { margin: 0; background: #fffef7; color: #12110e; font: 400 17px/1.6 'Poppins', Arial, sans-serif; }
  main { max-width: 980px; margin: 0 auto; padding: 56px 40px 600px; }
  .doc { font: 600 13px 'Poppins'; letter-spacing: 2px; text-transform: uppercase; color: #b04617; margin-bottom: 18px; }
  h1, h2, h3, h4 { font-family: 'Unbounded', Verdana, sans-serif; line-height: 1.2; margin: 1.6em 0 .5em; }
  h1 { font-size: 30px; } h2 { font-size: 22px; } h3 { font-size: 18px; } h4 { font-size: 16px; }
  code { background: #f6f3ec; border-radius: 4px; padding: 1px 6px; font: 14px ui-monospace, Menlo, monospace; }
  pre { background: #f6f3ec; border-radius: 10px; padding: 16px; font: 14px/1.5 ui-monospace, Menlo, monospace; white-space: pre-wrap; }
  table { border-collapse: collapse; margin: 16px 0; font-size: 15px; } th, td { border-bottom: 1px solid #e6e0d2; padding: 8px 12px; text-align: left; vertical-align: top; }
  th { background: #f6f3ec; } blockquote { border-left: 4px solid #b04617; margin: 14px 0; padding: 2px 16px; color: #6f6758; }
  mark { background: #ffd966; color: #12110e; padding: 2px 4px; border-radius: 4px; box-shadow: 0 0 0 6px rgba(255,217,102,.55); }
</style></head><body><main><div class="doc">${escapeHtml(title)}</div>${body}</main></body></html>`

async function glide(page, targetY, ms) {
  await page.evaluate(({ targetY, ms }) => new Promise((resolve) => {
    const from = window.scrollY, delta = targetY - from, t0 = performance.now()
    const ease = (t) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2)
    const step = (now) => { const k = Math.min(1, (now - t0) / ms); window.scrollTo(0, from + delta * ease(k)); k < 1 ? requestAnimationFrame(step) : resolve() }
    requestAnimationFrame(step)
  }), { targetY, ms })
}

;(async () => {
  const args = parseArgs()
  const cfg = config(args)
  let plan = DEFAULTS
  if (args.docs) plan = String(args.docs).split("|").map((doc) => ({ doc, focus: args.focus ? String(args.focus).split("|") : [] }))
  else if (args.focus) plan = [{ doc: "PROCESS.md", focus: String(args.focus).split("|") }]

  const run = await new Run("process", cfg).launch()
  const renderDir = path.join(run.dir, "_render")
  fs.mkdirSync(renderDir, { recursive: true })
  const pages = []
  for (const { doc, focus } of plan) {
    const file = path.join(ROOT, doc)
    if (!fs.existsSync(file)) { console.warn(`  skipping ${doc}: not found`); continue }
    const html = path.join(renderDir, path.basename(doc).replace(/\W+/g, "-") + ".html")
    fs.writeFileSync(html, PAGE(doc, markdown(fs.readFileSync(file, "utf8"))))
    pages.push({ doc, focus, url: "file://" + html })
  }
  if (!pages.length) { console.error("Nothing to show."); process.exit(1) }

  const stage = await run.stage("doc", { route: pages[0].url })
  for (const [index, { doc, focus, url }] of pages.entries()) {
    if (index > 0) await stage.page.goto(url, { waitUntil: "load" })
    await stage.page.evaluate(() => document.fonts.ready)
    await sleep(1500 * cfg.slow)
    run.mark(`showing ${doc}`)
    for (const phrase of focus) {
      const found = await stage.page.evaluate((needle) => {
        const walker = document.createTreeWalker(document.querySelector("main"), NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const at = node.nodeValue.indexOf(needle)
          if (at < 0) continue
          const range = document.createRange()
          range.setStart(node, at); range.setEnd(node, at + needle.length)
          const mark = document.createElement("mark")
          range.surroundContents(mark)
          const top = mark.getBoundingClientRect().top + window.scrollY
          return { top }
        }
        return null
      }, phrase)
      if (!found) { run.mark("NOT FOUND", phrase); continue }
      const viewport = await stage.page.evaluate(() => window.innerHeight)
      await glide(stage.page, Math.max(0, found.top - viewport * 0.35), 1600 * cfg.slow)
      run.mark("highlighted", phrase)
      await sleep(4200 * cfg.slow)
    }
  }
  await run.finish()
})()
