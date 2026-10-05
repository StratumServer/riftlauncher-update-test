#!/usr/bin/env node
/**
 * Runs one beta to stable update scenario of RiftLauncher on a fresh Windows runner, and leaves
 * its evidence in $EVIDENCE: report.json, timeline.log, desktop and page screenshots, the
 * launcher's logs, process lists, registry entries and profile snapshots.
 *
 *   node windows/driver.mjs <on|off|unset|defer>
 *
 * on, off, unset: receiveBetaUpdates true, false, or absent from config.json. Install
 * 1.7.0-beta.13 per user and silently, seed a profile, launch it with a DevTools port, accept the
 * 1.7.0 offer, wait for the download, press Restart and update, then follow the installer it starts
 * until 1.7.0 runs from the same folder.
 *
 * defer: receiveBetaUpdates absent. First launch: Not now, close. Second launch: Update now, wait
 * for the download, close without Restart and update. Third launch: whatever is installed by then.
 *
 * The launcher is driven with RiftLauncher's own scripts/headless/cdp.mjs, checked out at the
 * pinned dev commit beside this repository. Only the launcher's update controls are clicked, by
 * selector: the action buttons of the update toasts, which carry aria-label = their text
 * (src/renderer/src/components/layout/NotificationsOverlay.tsx at v1.7.0-beta.13). No key is ever
 * sent, and anything named Play or Join is refused. In the installer window, only Next >, Install
 * and Finish are ever pressed, and only once the installer has been sitting on a page for a while,
 * which is what a player would have to do.
 */

import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { appendFileSync, closeSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { setTimeout as sleep } from "node:timers/promises"

const SCENARIOS = { on: true, off: false, unset: undefined, defer: undefined }
const scenario = process.argv[2]
if (!Object.hasOwn(SCENARIOS, scenario)) {
  console.error("usage: node windows/driver.mjs <on|off|unset|defer>")
  process.exit(2)
}

const WS = process.env.GITHUB_WORKSPACE
const EVIDENCE = process.env.EVIDENCE
const APPDATA = process.env.APPDATA
const LOCALAPPDATA = process.env.LOCALAPPDATA
if (!WS || !EVIDENCE || !APPDATA || !LOCALAPPDATA || process.platform !== "win32") {
  console.error("Runs on a Windows runner only, with GITHUB_WORKSPACE, EVIDENCE, APPDATA and LOCALAPPDATA set.")
  process.exit(2)
}

const P = {
  oldSetup: join(WS, "installers", "old", "dist", "riftlauncher-1.7.0-beta.13-setup.exe"),
  newFeed: join(WS, "installers", "new", "dist", "latest.yml"),
  seed: join(WS, "rl-new", "scripts", "headless", "seed.mjs"),
  cdp: join(WS, "rl-new", "scripts", "headless", "cdp.mjs"),
  win: join(WS, "harness", "windows", "win.ps1"),
  userData: join(APPDATA, "RiftLauncher"),
  updaterCache: join(LOCALAPPDATA, "riftlauncher-updater")
}
const INFO_LOG = join(P.userData, "Logs", "info.log")
/** One DevTools port per launch: the installer the launcher spawns inherits its listening socket and keeps the port while it runs. */
let port = 9250
const NEW_VERSION = "1.7.0"
const OLD_VERSION = "1.7.0-beta.13"

/** One made-up installation with two made-up Mods and an empty version folder. No game, no account. */
const SEED_SPEC = {
  installations: [{ name: "Update Check", gameVersion: "1.21.1", mods: ["Primitive Survival", "Carry On"] }],
  // The runner's screen is small; this keeps the whole window, and its toasts, on it.
  window: { width: 1024, height: 700 },
  lastSeenChangelogVersion: OLD_VERSION,
  moddbVisibilityAnswer: "declined"
}

const OFFER_TEXT = "is available. Do you want to download it now?"
const READY_TEXT = "The update is ready to install."
const RETRY_TEXT = "failed. Do you want to try again?"
const FORBIDDEN = /\b(play|join)\b/i
/** Buttons of the prompts a fresh launch can open, safe to answer: none of them starts anything. */
const SAFE_DISMISS = ["No thanks", "Not this time", "Got it"]
const INSTALLER_BUTTONS = ["Finish", "Install", "Next >"]
/** How long the installer may sit on one page before the player's click is made for it. */
const PLAYER_PAUSE_MS = 20_000

// --- evidence --------------------------------------------------------------------------------

mkdirSync(join(EVIDENCE, "shots"), { recursive: true })
mkdirSync(join(EVIDENCE, "snapshots"), { recursive: true })
const t0 = Date.now()
const report = {
  scenario,
  receiveBetaUpdates: SCENARIOS[scenario] === undefined ? "(absent)" : SCENARIOS[scenario],
  startedAt: new Date().toISOString(),
  verdict: {},
  errors: [],
  steps: []
}
const state = { exe: null, installDir: null }

const secs = () => Number(((Date.now() - t0) / 1000).toFixed(1))
function save() {
  writeFileSync(join(EVIDENCE, "report.json"), JSON.stringify(report, null, 2))
}
function writeJson(name, value) {
  writeFileSync(join(EVIDENCE, name), JSON.stringify(value, null, 2))
}
function log(message, data) {
  const line = `[${secs()}s] ${message}`
  console.log(line)
  appendFileSync(join(EVIDENCE, "timeline.log"), line + "\n")
  report.steps.push(data === undefined ? { at: secs(), message } : { at: secs(), message, data })
  save()
}
function fail(message) {
  report.errors.push(message)
  log(`ERROR: ${message}`)
}

// --- probes ----------------------------------------------------------------------------------

/**
 * Windows PowerShell started from the step's PowerShell 7 inherits its PSModulePath and then cannot
 * load its own modules (Get-CimInstance, Get-FileHash), so it gets the environment without it.
 */
const PS_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => k.toLowerCase() !== "psmodulepath"))

function ps(action, target = "", name = "") {
  const args = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", P.win, "-Action", action]
  if (target) args.push("-Target", target)
  if (name) args.push("-Name", name)
  const r = spawnSync("powershell.exe", args, { encoding: "utf8", timeout: 120_000, windowsHide: true, env: PS_ENV })
  if (r.status !== 0) throw new Error(`win.ps1 ${action} failed (${r.status ?? r.signal ?? r.error?.message}): ${(r.stderr || "").trim().slice(0, 1500)}`)
  const out = (r.stdout || "").replace(/^\uFEFF/, "").trim()
  return out ? JSON.parse(out) : null
}
function tryPs(action, target = "", name = "") {
  try {
    return ps(action, target, name)
  } catch (error) {
    report.errors.push(error.message)
    return null
  }
}

let shotCount = 0
function desktopShot(label) {
  const file = join(EVIDENCE, "shots", `${String(++shotCount).padStart(2, "0")}-${label}.png`)
  return tryPs("shot", file) ? basename(file) : null
}

function cdp(...args) {
  const r = spawnSync(process.execPath, [P.cdp, ...args], { encoding: "utf8", timeout: 45_000, windowsHide: true, env: { ...process.env, CDP_PORT: String(port) } })
  return { ok: r.status === 0, out: (r.stdout || "").trim(), err: (r.stderr || r.error?.message || "").trim() }
}
function cdpEval(expression) {
  const r = cdp("eval", expression)
  if (!r.ok) throw new Error(`cdp eval failed: ${r.err}`)
  try {
    return JSON.parse(r.out)
  } catch {
    return r.out
  }
}
function pageShot(label) {
  const file = join(EVIDENCE, "shots", `${String(++shotCount).padStart(2, "0")}-${label}-page.png`)
  return cdp("shot", file).ok ? basename(file) : null
}
function pageText() {
  const r = cdp("text")
  return r.ok ? r.out : `(page text unavailable: ${r.err})`
}

async function until(fn, timeoutMs, everyMs = 1000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    try {
      const value = await fn()
      if (value) return value
    } catch {
      // not there yet
    }
    await sleep(everyMs)
  }
  return null
}

const samePath = (a, b) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase()
const procs = () => ps("procs") ?? []
const launcherProcs = (list) => list.filter((p) => samePath(p.path, state.exe))
const mainOf = (list) => launcherProcs(list).find((p) => !/--type=/.test(p.cmd ?? ""))
const isPendingInstaller = (p) => /\\riftlauncher-updater\\pending\\/i.test(p.path ?? "")

function logSize() {
  try {
    return statSync(INFO_LOG).size
  } catch {
    return 0
  }
}
function logSince(offset) {
  try {
    return readFileSync(INFO_LOG).subarray(offset).toString("utf8")
  } catch {
    return ""
  }
}
const updaterLines = (text) =>
  text
    .split(/\r?\n/)
    .filter((l) => /autoUpdater|appUpdater|setUpUserDataFolder|scheduleUpdateCheck|Electron ready/.test(l) && !/Adding listener/.test(l))
    .map((l) => l.slice(0, 400))

function listing(dir) {
  if (!existsSync(dir)) return null
  const out = {}
  const walk = (abs, rel) => {
    for (const e of readdirSync(abs, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) walk(join(abs, e.name), r)
      else out[r] = statSync(join(abs, e.name)).size
    }
  }
  walk(dir, "")
  return out
}

// --- profile ---------------------------------------------------------------------------------

const PROFILE_ROOTS = ["RiftLauncher", "RiftLauncherInstallations", "RiftLauncherGameVersions", "RiftLauncherBackups"]
/** Left out of the hash, as asked: the logs and Chromium's caches. Everything else is hashed. */
const UNHASHED = /^RiftLauncher\/(Logs|Cache\/Cache_Data|Cache\/No_Vary_Search|Code Cache|GPUCache|DawnCache|DawnGraphiteCache|DawnWebGPUCache|GrShaderCache|ShaderCache|blob_storage|Crashpad)(\/|$)/
/** What the launcher itself keeps; the rest of RiftLauncher/ is Chromium's own profile state. */
const LAUNCHER_OWNED = /^(RiftLauncherInstallations|RiftLauncherGameVersions|RiftLauncherBackups)(\/|$)|^RiftLauncher\/(config[^/]*\.json|account-secrets[^/]*\.json|Icons|Sessions|Cache\/(ModCatalog|Images|Backgrounds|Optimum))(\/|$)/
/** The config fields that hold the player's data; window size and prompt answers are not in it. */
const DATA_KEYS = ["schemaVersion", "installations", "gameVersions", "defaultInstallationsFolder", "defaultVersionsFolder", "backupsFolder", "accounts", "activeAccountId", "favMods", "suspendedModUpdates", "background", "accentColor", "customIcons", "receiveBetaUpdates", "measurePlaySessions", "allowBasicSessionStore", "modSuggestionsConsent", "dismissedModSuggestions"]

function readConfig() {
  try {
    return JSON.parse(readFileSync(join(P.userData, "config.json"), "utf8").replace(/^\uFEFF/, ""))
  } catch (error) {
    return { unreadable: error.message }
  }
}

function snapshot(label) {
  const files = {}
  const dirs = []
  const walk = (abs, rel) => {
    let entries
    try {
      entries = readdirSync(abs, { withFileTypes: true })
    } catch (error) {
      files[`${rel}/`] = `unreadable (${error.code})`
      return
    }
    for (const e of entries) {
      const r = `${rel}/${e.name}`
      if (UNHASHED.test(r)) continue
      const a = join(abs, e.name)
      if (e.isDirectory()) {
        dirs.push(r)
        walk(a, r)
      } else {
        try {
          files[r] = createHash("sha256").update(readFileSync(a)).digest("hex")
        } catch (error) {
          files[r] = `unreadable (${error.code})`
        }
      }
    }
  }
  for (const root of PROFILE_ROOTS) {
    if (!existsSync(join(APPDATA, root))) continue
    dirs.push(root)
    walk(join(APPDATA, root), root)
  }
  const snap = { label, at: secs(), files, dirs, config: readConfig() }
  writeJson(join("snapshots", `${label}.json`), snap)
  log(`snapshot ${label}: ${Object.keys(files).length} files, ${dirs.length} folders`)
  return snap
}

function compare(a, b) {
  const changed = []
  const removed = []
  const added = []
  for (const [k, v] of Object.entries(a.files)) {
    if (!(k in b.files)) removed.push(k)
    else if (b.files[k] !== v) changed.push(k)
  }
  for (const k of Object.keys(b.files)) if (!(k in a.files)) added.push(k)
  const dirsRemoved = a.dirs.filter((d) => !b.dirs.includes(d))
  const config = {}
  for (const k of new Set([...Object.keys(a.config), ...Object.keys(b.config)])) {
    const x = JSON.stringify(a.config[k])
    const y = JSON.stringify(b.config[k])
    if (x !== y) config[k] = { from: k in a.config ? a.config[k] : "(absent)", to: k in b.config ? b.config[k] : "(absent)" }
  }
  // An absent receiveBetaUpdates and a null one mean the same thing to the launcher (betaUpdates.ts).
  const dataKeysChanged = DATA_KEYS.filter((k) => k in config && !(k === "receiveBetaUpdates" && (a.config[k] ?? null) === (b.config[k] ?? null)))
  const owned = (list) => list.filter((k) => LAUNCHER_OWNED.test(k))
  const launcherFilesChanged = owned(changed).filter((k) => k !== "RiftLauncher/config.json")
  return {
    from: a.label,
    to: b.label,
    launcher: { changed: owned(changed), removed: owned(removed), added: owned(added), foldersRemoved: owned(dirsRemoved) },
    chromium: { changed: changed.filter((k) => !LAUNCHER_OWNED.test(k)), removed: removed.filter((k) => !LAUNCHER_OWNED.test(k)), added: added.filter((k) => !LAUNCHER_OWNED.test(k)) },
    config,
    dataKeysChanged,
    /** Every launcher file and folder of `a` is still there, byte for byte apart from config.json. */
    kept: launcherFilesChanged.length === 0 && owned(removed).length === 0 && owned(dirsRemoved).length === 0,
    intact: dataKeysChanged.length === 0 && launcherFilesChanged.length === 0 && owned(removed).length === 0 && owned(dirsRemoved).length === 0
  }
}

/** Rewrites every path under `from` to sit under `to`, since seed.mjs writes absolute paths. */
function rebase(value, from, to) {
  if (typeof value === "string") return value.toLowerCase().startsWith(from.toLowerCase()) ? to + value.slice(from.length) : value
  if (Array.isArray(value)) return value.map((v) => rebase(v, from, to))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, rebase(v, from, to)]))
  return value
}

function seedProfile() {
  const root = join(process.env.RUNNER_TEMP, "seed")
  mkdirSync(root, { recursive: true })
  const specPath = join(root, "spec.json")
  writeFileSync(specPath, JSON.stringify(SEED_SPEC, null, 2))
  const profile = join(root, "profile")
  const r = spawnSync(process.execPath, [P.seed, specPath, profile], { encoding: "utf8", timeout: 60_000 })
  if (r.status !== 0) throw new Error(`seed.mjs failed: ${r.stderr || r.error?.message}`)
  // seed.mjs lays the profile out as <root>/config/{RiftLauncher,RiftLauncherInstallations,...},
  // the XDG shape. On Windows the launcher reads them straight under %APPDATA%.
  const from = join(profile, "config")
  for (const name of readdirSync(from)) {
    const dest = join(APPDATA, name)
    if (existsSync(dest)) throw new Error(`${dest} exists before the first launch`)
    cpSync(join(from, name), dest, { recursive: true })
  }
  const file = join(P.userData, "config.json")
  const config = rebase(JSON.parse(readFileSync(file, "utf8")), from, APPDATA)
  if (SCENARIOS[scenario] === undefined) delete config.receiveBetaUpdates
  else config.receiveBetaUpdates = SCENARIOS[scenario]
  writeFileSync(file, JSON.stringify(config, null, 2))
  log(`seeded the profile under %APPDATA%: receiveBetaUpdates ${report.receiveBetaUpdates}`, { config })
}

// --- launcher --------------------------------------------------------------------------------

async function launch(label) {
  port += 1
  const out = openSync(join(EVIDENCE, `app-${label}.log`), "a")
  // PS_ENV, not this step's environment: the launcher passes its environment on to the installer,
  // whose running-app check runs Windows PowerShell, which PowerShell 7's module path breaks.
  const child = spawn(state.exe, [`--remote-debugging-port=${port}`], { detached: true, stdio: ["ignore", out, out], env: PS_ENV })
  child.unref()
  closeSync(out)
  log(`${label}: started the installed RiftLauncher.exe (pid ${child.pid}) with --remote-debugging-port=${port}, UPDATE unset`)
  const target = await until(async () => {
    const res = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(3000) })
    return (await res.json()).find((t) => t.type === "page" && String(t.url).startsWith("app://"))
  }, 90_000)
  if (!target) throw new Error(`${label}: no app:// page on the DevTools port within 90 s`)
  const bridge = await until(() => cdpEval('typeof window.api?.utils?.getAppVersion === "function"') === true, 60_000)
  if (!bridge) throw new Error(`${label}: the preload bridge never showed up`)
  const version = cdpEval("(async () => await window.api.utils.getAppVersion())()")
  const userData = cdpEval("(async () => await window.api.pathsManager.getCurrentUserDataPath())()")
  await sleep(3000)
  const text = pageText()
  log(`${label}: running ${version}, userData ${userData}`, { visibleText: text.slice(0, 2500) })
  desktopShot(`${label}-window`)
  pageShot(label)
  return { pid: child.pid, version, userData }
}

function element(selector) {
  return cdpEval(
    `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return null; const r = el.getBoundingClientRect(); return { label: el.getAttribute("aria-label"), text: el.innerText, x: r.x, y: r.y } })()`
  )
}

/**
 * Clicks one launcher control by selector, after checking its accessible name. `closesApp` is for
 * Restart and update: the launcher may quit before the DevTools call answers, which is not a
 * failure of the click.
 */
async function safeClick(selector, expectedLabel, { closesApp = false } = {}) {
  let info = element(selector)
  if (!info) throw new Error(`nothing matches ${selector}`)
  if (info.label !== expectedLabel || FORBIDDEN.test(info.label ?? "") || FORBIDDEN.test(info.text ?? "")) throw new Error(`refusing to click ${JSON.stringify(info)}`)
  // Toasts slide in from the right; click once the button has stopped moving.
  for (let i = 0; i < 15; i++) {
    await sleep(400)
    const now = element(selector)
    if (!now) throw new Error(`${expectedLabel} went away before it could be clicked`)
    if (Math.abs(now.x - info.x) < 0.5 && Math.abs(now.y - info.y) < 0.5) break
    info = now
  }
  let r = cdp("click", selector)
  if (!r.ok && /covered/.test(r.err) && !SAFE_DISMISS.includes(expectedLabel)) {
    await dismissPrompts("covered")
    r = cdp("click", selector)
  }
  if (!r.ok && closesApp) {
    log(`clicked "${expectedLabel}"; the DevTools call did not answer (${r.err}), the launcher was closing`)
    return
  }
  if (!r.ok) throw new Error(`clicking ${expectedLabel} failed: ${r.err}`)
  log(`clicked "${expectedLabel}"`)
}

function findToast(part) {
  return cdpEval(
    `(() => { const t = [...document.querySelectorAll("[data-toast-id]")].find((e) => e.innerText.includes(${JSON.stringify(part)})); return t ? { id: t.getAttribute("data-toast-id"), text: t.innerText, buttons: [...t.querySelectorAll("button")].map((b) => b.getAttribute("aria-label")) } : null })()`
  )
}
const toastButton = (id, label) => `[data-toast-id="${id}"] button[aria-label="${label}"]`

async function dismissPrompts(label) {
  for (const name of SAFE_DISMISS) {
    const selector = `button[aria-label="${name}"]`
    if (cdpEval(`!!document.querySelector(${JSON.stringify(selector)})`) !== true) continue
    desktopShot(`${label}-prompt-${name.replace(/\W+/g, "-").toLowerCase()}`)
    await safeClick(selector, name)
    await sleep(1000)
  }
}

async function waitOffer(label, since) {
  const offer = await until(() => findToast(OFFER_TEXT), 120_000)
  if (!offer) {
    log(`${label}: no update offer within 120 s`, { updaterLog: updaterLines(logSince(since)) })
    return null
  }
  log(`${label}: offer shown: "${offer.text.replace(/\s+/g, " ").trim()}"`, { buttons: offer.buttons })
  desktopShot(`${label}-offer`)
  // A prompt can open after the launch settled; answer it before reaching for the toast.
  await dismissPrompts(label)
  return offer
}

async function acceptAndDownload(label, offer, since) {
  const startedAt = Date.now()
  await safeClick(toastButton(offer.id, "Update now"), "Update now")
  await sleep(1500)
  desktopShot(`${label}-downloading`)
  let failed = null
  const ready = await until(() => {
    failed = findToast(RETRY_TEXT)
    if (failed) return true
    return findToast(READY_TEXT)
  }, 600_000, 2000)
  if (!ready || failed) {
    log(`${label}: the download did not finish (${failed ? "the retry offer came up" : "nothing within 600 s"})`, { updaterLog: updaterLines(logSince(since)) })
    return null
  }
  const toast = findToast(READY_TEXT)
  log(`${label}: download finished after ${((Date.now() - startedAt) / 1000).toFixed(1)} s: "${toast.text.replace(/\s+/g, " ").trim()}"`, { buttons: toast.buttons })
  desktopShot(`${label}-ready`)
  pageShot(`${label}-ready`)
  return toast
}

function verifyPending() {
  const pendingDir = join(P.updaterCache, "pending")
  const name = existsSync(pendingDir) ? readdirSync(pendingDir).find((f) => f.toLowerCase() === `riftlauncher-${NEW_VERSION}-setup.exe`) : undefined
  const expected = /^sha512: (\S+)/m.exec(readFileSync(P.newFeed, "utf8"))?.[1] ?? null
  const actual = name ? createHash("sha512").update(readFileSync(join(pendingDir, name))).digest("base64") : null
  let updateInfo = null
  try {
    updateInfo = JSON.parse(readFileSync(join(pendingDir, "update-info.json"), "utf8"))
  } catch {
    // absent
  }
  const result = { file: name ?? null, expected, actual, match: actual !== null && actual === expected, updateInfo, updaterCache: listing(P.updaterCache) }
  log(`pending installer sha512 ${result.match ? "matches" : "DOES NOT match"} the published latest.yml`, result)
  return result
}

/** One process start and stop trace for the whole run (win.ps1 trace). */
let trace = null
function startTrace() {
  const file = join(EVIDENCE, "process-trace.jsonl")
  const stopFile = join(process.env.RUNNER_TEMP, "stop-trace")
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", P.win, "-Action", "trace", "-Target", file, "-Name", stopFile, "-Ignore", String(process.pid)], { stdio: "ignore", windowsHide: true, env: PS_ENV })
  trace = { file, stopFile, child }
}
async function stopTrace() {
  if (!trace) return
  writeFileSync(trace.stopFile, "stop")
  if (!(await until(() => trace.child.exitCode !== null, 15_000, 500))) trace.child.kill()
}
/** The traced starts and stops between two moments, a second of margin either side, after letting the trace catch up. */
async function traceBetween(label, fromMs, toMs) {
  await sleep(2000)
  let entries = []
  try {
    entries = readFileSync(trace.file, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l)).filter((e) => e.t && Date.parse(e.t) >= fromMs - 1000 && Date.parse(e.t) <= toMs + 1000)
  } catch (error) {
    report.errors.push(`reading the process trace: ${error.message}`)
  }
  for (const e of entries) log(`${label}: trace ${e.t.slice(11, 23)} ${e.kind} ${e.name} pid ${e.pid} parent ${e.ppid}${e.kind === "stop" ? ` exit ${e.exitStatus}` : ""}${e.cmd ? `: ${e.cmd.slice(0, 260)}` : ""}`)
  return entries
}

const watchers = new Set()
function startWatcher(label) {
  const dir = join(EVIDENCE, `watch-${label}`)
  const stopFile = join(process.env.RUNNER_TEMP, `stop-watch-${label}`)
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", P.win, "-Action", "watch", "-Target", dir, "-Name", stopFile], { stdio: "ignore", windowsHide: true, env: PS_ENV })
  const watcher = { dir, stopFile, child }
  watchers.add(watcher)
  return watcher
}

async function stopWatcher(watcher) {
  watchers.delete(watcher)
  writeFileSync(watcher.stopFile, "stop")
  const exited = await until(() => watcher.child.exitCode !== null, 20_000, 500)
  if (!exited) watcher.child.kill()
  // What showed up on screen while it watched that was not there when it started, by process.
  const appeared = new Set()
  let baseline = null
  try {
    for (const line of readFileSync(join(watcher.dir, "watch.jsonl"), "utf8").split("\n")) {
      if (!line.trim()) continue
      const windows = JSON.parse(line).windows
      if (!windows) continue
      const keys = windows.map((w) => {
        const [pid, process, cls, title] = w.split("|")
        return `${process} (pid ${pid}) | ${cls} | ${title}`
      })
      if (baseline === null) baseline = new Set(keys)
      else for (const k of keys) if (!baseline.has(k)) appeared.add(k)
    }
  } catch (error) {
    report.errors.push(`watch log of ${watcher.dir}: ${error.message}`)
  }
  return [...appeared]
}

async function closeLauncher(label) {
  const list = procs()
  const main = mainOf(list)
  if (!main) return { closed: true, note: "no launcher process was running" }
  const sent = ps("close", String(main.pid))
  const gone = await until(() => launcherProcs(procs()).length === 0, 60_000, 1000)
  if (!gone) {
    fail(`${label}: the launcher was still running 60 s after its window was asked to close; killing it`)
    spawnSync("taskkill", ["/PID", String(main.pid), "/T", "/F"], { windowsHide: true })
  }
  log(`${label}: closed through its window (WM_CLOSE to pid ${main.pid}, ${sent.closeMessagesSent} window(s)) ${gone ? "and every launcher process exited" : "but it had to be killed"}`)
  return { closed: Boolean(gone), sent }
}

/** What is on the installer's screen: the text and state of every visible control. */
function pageSignature(controls) {
  return (controls ?? [])
    .filter((c) => c.Visible && c.Text)
    .map((c) => `${c.Class}:${c.Text.replace(/\s+/g, " ").trim()}${c.Enabled ? "" : " (disabled)"}${c.Check === 1 ? " [checked]" : ""}`)
    .join(" | ")
}
function playerButton(controls) {
  for (const name of INSTALLER_BUTTONS) {
    if ((controls ?? []).some((c) => c.Class === "Button" && c.Visible && c.Enabled && c.Text.replace(/&/g, "") === name)) return name
  }
  return null
}

/**
 * Follows what happens after the launcher hands over to the installer, until a fresh launcher
 * process runs from the install folder, or until nothing is left to wait for. `waitForPlayer`
 * lets the installer's pages be answered the way a player would, after a pause on each.
 */
async function followInstaller(label, oldPids, startedAt, { waitForPlayer, deadlineMs }) {
  const seen = { installer: null, installerExitAfterS: null, oldGoneAfterS: null, newLauncher: null, pages: [], presses: [], uninstallers: [], runningAppChecks: [] }
  let lastSignature = ""
  let pageSince = Date.now()
  let quietSince = null
  const end = Date.now() + deadlineMs
  const at = () => Number(((Date.now() - startedAt) / 1000).toFixed(1))
  while (Date.now() < end) {
    const list = tryPs("procs")
    if (!list) {
      await sleep(1500)
      continue
    }
    const installer = list.find(isPendingInstaller)
    // The installer's running-app check: PowerShell one-liners looking for, then stopping, any
    // process whose path is under the install folder (allowOnlyOneInstallerInstance.nsh).
    for (const c of list.filter((p) => p.name === "powershell.exe")) {
      if (!seen.runningAppChecks.some((x) => x.pid === c.pid)) {
        seen.runningAppChecks.push({ pid: c.pid, ppid: c.ppid, seenAfterS: at(), cmd: c.cmd })
        log(`${label}: running-app check after ${at()} s: ${(c.cmd ?? "").slice(0, 300)}`)
      }
    }
    if (installer && !seen.installer) {
      seen.installer = { ...installer, seenAfterS: at() }
      log(`${label}: installer running after ${at()} s: ${installer.cmd}`)
    }
    if (seen.installer && !installer && seen.installerExitAfterS === null) {
      seen.installerExitAfterS = at()
      log(`${label}: installer exited after ${at()} s`)
    }
    for (const u of list.filter((p) => /^un_[a-z]\.exe$/i.test(p.name) || /^uninstall riftlauncher/i.test(p.name))) {
      if (!seen.uninstallers.some((x) => x.pid === u.pid)) {
        seen.uninstallers.push({ ...u, seenAfterS: at() })
        log(`${label}: old version's uninstaller running after ${at()} s: ${u.cmd}`)
      }
    }
    const oldAlive = list.some((p) => oldPids.includes(p.pid))
    if (!oldAlive && seen.oldGoneAfterS === null) {
      seen.oldGoneAfterS = at()
      log(`${label}: every process of the old launcher had exited after ${at()} s`)
    }
    const fresh = mainOf(list.filter((p) => !oldPids.includes(p.pid)))
    if (fresh && !seen.newLauncher) {
      seen.newLauncher = { ...fresh, seenAfterS: at() }
      log(`${label}: a new launcher process runs from the install folder after ${at()} s: ${fresh.cmd}`)
      desktopShot(`${label}-new-launcher-up`)
    }
    const ui = installer ? tryPs("controls", String(installer.pid)) : null
    if (ui) {
      const signature = pageSignature(ui)
      if (signature !== lastSignature) {
        lastSignature = signature
        pageSince = Date.now()
        const shot = desktopShot(`${label}-installer-${seen.pages.length + 1}`)
        seen.pages.push({ atS: at(), shot, screen: signature, controls: ui })
        log(`${label}: installer screen ${seen.pages.length}: ${signature.slice(0, 900) || "(no window)"}`)
      } else if (waitForPlayer && !oldAlive && Date.now() - pageSince >= PLAYER_PAUSE_MS && seen.presses.length < 6) {
        const name = playerButton(ui)
        if (name) {
          const shot = desktopShot(`${label}-installer-waiting-${seen.presses.length + 1}`)
          const pressed = tryPs("press", String(installer.pid), name)
          seen.presses.push({ atS: at(), button: name, waitedS: Number(((Date.now() - pageSince) / 1000).toFixed(1)), shot, pressed })
          log(`${label}: the installer had waited ${seen.presses.at(-1).waitedS} s on its page; pressed "${name}" as a player would`, pressed)
          pageSince = Date.now()
        }
      }
    }
    // Settled: the new launcher is up and the installer is gone, or (no restart expected) the old
    // launcher and the installer are both gone and nothing else showed up for a while.
    if (seen.newLauncher && !installer) break
    const settled = seen.oldGoneAfterS !== null && !installer && (seen.installer !== null || at() > 60)
    if (settled && !waitForPlayer) {
      quietSince ??= Date.now()
      if (Date.now() - quietSince > 20_000) break
    } else quietSince = null
    await sleep(1500)
  }
  return seen
}

async function waitVersionLine(since) {
  const line = await until(() => logSince(since).split(/\r?\n/).find((l) => /Update for version \S+ is not available|Found version|Update check failed|is not available/.test(l)), 90_000, 2000)
  return line ? line.slice(0, 400) : null
}

function installState(label) {
  const reg = tryPs("reg")
  const exe = tryPs("ver", state.exe)
  writeJson(`reg-${label}.json`, reg)
  writeJson(`exe-${label}.json`, exe)
  writeJson(`install-folder-${label}.json`, listing(state.installDir))
  const shortcuts = shortcutState()
  writeJson(`shortcuts-${label}.json`, shortcuts)
  const displayVersion = reg?.hkcuUninstall?.[0]?.values?.DisplayVersion ?? null
  log(`${label}: exe ProductVersion ${exe?.productVersion}, FileVersion ${exe?.fileVersion}, HKCU DisplayVersion ${displayVersion}, HKLM entries ${reg?.hklmUninstall?.length ?? "?"}`)
  return { reg, exe, displayVersion, shortcuts }
}
/** The per-user shortcuts the installer made, which an update is meant to keep. */
function shortcutState() {
  const places = { desktop: join(process.env.USERPROFILE, "Desktop", "RiftLauncher.lnk"), startMenu: join(APPDATA, "Microsoft", "Windows", "Start Menu", "Programs", "RiftLauncher.lnk") }
  return Object.fromEntries(Object.entries(places).map(([k, file]) => {
    try {
      const st = statSync(file)
      return [k, { exists: true, size: st.size, modified: st.mtime.toISOString(), sha256: createHash("sha256").update(readFileSync(file)).digest("hex") }]
    } catch {
      return [k, { exists: false }]
    }
  }))
}
/** The exe's FileVersion and the uninstall entry's DisplayVersion both say `v`. Its ProductVersion is 1.7.0.0 for the beta and the stable alike. */
const isVersion = (s, v) => Boolean(s?.exe?.exists) && s.displayVersion === v && s.exe.fileVersion === v

// --- scenarios -------------------------------------------------------------------------------

async function installOld() {
  const started = Date.now()
  const r = spawnSync(P.oldSetup, ["/S"], { timeout: 300_000 })
  log(`installed ${basename(P.oldSetup)} with /S: exit ${r.status ?? r.error?.message} after ${((Date.now() - started) / 1000).toFixed(1)} s`)
  const reg = ps("reg")
  writeJson("reg-installed-old.json", reg)
  const installDir = reg?.hkcuInstall?.[0]?.values?.InstallLocation ?? reg?.hkcuUninstall?.[0]?.values?.InstallLocation
  if (!installDir) throw new Error("no per-user install entry after the silent install")
  state.installDir = installDir
  state.exe = join(installDir, "RiftLauncher.exe")
  const exe = ps("ver", state.exe)
  writeJson("exe-installed-old.json", exe)
  // The installer keeps a copy of itself there; the differential download of the next version needs it.
  report.install = { exitCode: r.status, installDir, perMachineEntries: reg.hklmUninstall.length, uninstall: reg.hkcuUninstall, installKey: reg.hkcuInstall, exe, updaterCache: listing(P.updaterCache) }
  report.install.shortcuts = shortcutState()
  writeJson("install-folder-installed-old.json", listing(installDir))
  log(`OLD installed per user in ${installDir}: ProductVersion ${exe.productVersion}, DisplayVersion ${reg.hkcuUninstall[0]?.values?.DisplayVersion}`)
}

async function restartScenario() {
  const v = report.verdict
  const since = logSize()
  const s0 = snapshot("0-seeded")
  const first = await launch("old")
  report.oldVersionOverCdp = first.version
  await dismissPrompts("old")
  const offer = await waitOffer("old", since)
  v.offered = Boolean(offer)
  if (!offer) return
  const ready = await acceptAndDownload("old", offer, since)
  report.download = { updaterLog: updaterLines(logSince(since)) }
  if (!ready) return
  const pending = verifyPending()
  report.download.pending = pending
  v.downloadedVerified = pending.match
  const s1 = snapshot("1-before-restart")

  const oldPids = launcherProcs(procs()).map((p) => p.pid)
  const before = logSize()
  const watcher = startWatcher("restart")
  await sleep(2500)
  const clickedAt = Date.now()
  await safeClick(toastButton(ready.id, "Restart and update"), "Restart and update", { closesApp: true })
  const follow = await followInstaller("restart", oldPids, clickedAt, { waitForPlayer: true, deadlineMs: 300_000 })
  report.restart = follow
  follow.processTrace = await traceBetween("restart", clickedAt, Date.now())
  if (follow.newLauncher) {
    const versionLine = await waitVersionLine(before)
    report.restart.versionLogLine = versionLine
    log(`after the restart, the updater logged: ${versionLine ?? "(nothing within 90 s)"}`)
    await sleep(2000)
    desktopShot("after-restart")
    report.restart.processes = procs()
    writeJson("procs-after-restart.json", report.restart.processes)
  }
  report.restart.windowsSeen = await stopWatcher(watcher)
  report.restart.logAfterClick = updaterLines(logSince(before))
  const after = installState("after-restart")
  v.installed = isVersion(after, NEW_VERSION)
  v.restartedOn170 = Boolean(follow.newLauncher) && /version 1\.7\.0 is not available/.test(report.restart.versionLogLine ?? "")

  await closeLauncher("restarted")
  const s2 = snapshot("2-after-update")
  report.data = { seededVsAfter: compare(s0, s2), beforeRestartVsAfter: compare(s1, s2) }
  // The update must not touch anything the launcher held just before it, and the seeded
  // installation, Mods and version folder must all still be there.
  v.dataIntact = report.data.beforeRestartVsAfter.intact && report.data.seededVsAfter.kept

  const relaunch = await launch("new-relaunch")
  report.relaunch = { versionOverCdp: relaunch.version }
  await sleep(4000)
  report.relaunch.visibleText = pageText().slice(0, 2500)
  desktopShot("new-relaunch-settled")
  await closeLauncher("new-relaunch")
  report.data.afterRelaunch = compare(s2, snapshot("3-after-relaunch"))
  v.relaunchVersion = relaunch.version
}

async function deferScenario() {
  const v = report.verdict
  let since = logSize()
  const s0 = snapshot("0-seeded")
  const first = await launch("old-1")
  report.oldVersionOverCdp = first.version
  await dismissPrompts("old-1")
  const offer1 = await waitOffer("old-1", since)
  v.offeredFirst = Boolean(offer1)
  if (!offer1) return
  await safeClick(toastButton(offer1.id, "Not now"), "Not now")
  await sleep(3000)
  v.notNowDismissed = !findToast(OFFER_TEXT)
  desktopShot("old-1-after-not-now")
  const firstClose = await closeAndFollow("old-1")
  report.firstClose = firstClose
  report.afterFirstClose = installState("after-first-close")
  report.afterFirstClose.updaterCache = listing(P.updaterCache)
  snapshot("1-after-first-close")

  since = logSize()
  const second = await launch("old-2")
  report.secondLaunchVersion = second.version
  await dismissPrompts("old-2")
  const offer2 = await waitOffer("old-2", since)
  v.offeredAgain = Boolean(offer2)
  if (!offer2) return
  const ready = await acceptAndDownload("old-2", offer2, since)
  report.download = { updaterLog: updaterLines(logSince(since)) }
  if (!ready) return
  const pending = verifyPending()
  report.download.pending = pending
  v.downloadedVerified = pending.match
  const s1 = snapshot("2-before-quit")

  const quit = await closeAndFollow("old-2")
  report.quit = quit
  const afterQuit = installState("after-quit")
  v.installedOnQuit = isVersion(afterQuit, NEW_VERSION)
  v.somethingOnScreenDuringQuit = quit.windowsSeen.length > 0
  v.restartedOnQuit = Boolean(quit.newLauncher)
  const s2 = snapshot("3-after-quit")

  since = logSize()
  const third = await launch("third")
  report.thirdLaunch = { versionOverCdp: third.version }
  report.thirdLaunch.versionLogLine = await waitVersionLine(since)
  report.thirdLaunch.visibleText = pageText().slice(0, 2500)
  desktopShot("third-settled")
  await closeLauncher("third")
  v.thirdLaunchVersion = third.version
  const s3 = snapshot("4-after-third-launch")
  report.data = { seededVsAfterQuit: compare(s0, s2), beforeQuitVsAfterQuit: compare(s1, s2), seededVsEnd: compare(s0, s3) }
  v.dataIntact = report.data.beforeQuitVsAfterQuit.intact && report.data.seededVsAfterQuit.kept && report.data.seededVsEnd.kept
}

/** Closes the launcher the way its window's close button does, then watches what runs after it. */
async function closeAndFollow(label) {
  const list = procs()
  const oldPids = launcherProcs(list).map((p) => p.pid)
  const main = mainOf(list)
  if (!main) throw new Error(`${label}: the launcher is not running any more, there is nothing to close`)
  const before = logSize()
  const watcher = startWatcher(label)
  await sleep(2500)
  const closedAt = Date.now()
  const sent = ps("close", String(main.pid))
  log(`${label}: asked the launcher window to close (WM_CLOSE to pid ${main.pid}, ${sent.closeMessagesSent} window(s)); not pressing Restart and update`)
  const follow = await followInstaller(label, oldPids, closedAt, { waitForPlayer: false, deadlineMs: 240_000 })
  follow.processTrace = await traceBetween(label, closedAt, Date.now())
  follow.windowsSeen = await stopWatcher(watcher)
  follow.logAfterClose = updaterLines(logSince(before))
  follow.processesAfter = procs()
  log(`${label}: after the close: installer ${follow.installer ? `ran (${follow.installer.cmd})` : "never ran"}, new launcher ${follow.newLauncher ? "started" : "did not start"}, windows seen: ${follow.windowsSeen.join(" ; ") || "none"}`)
  desktopShot(`${label}-after-close`)
  return follow
}

// --- main ------------------------------------------------------------------------------------

async function main() {
  // The runner's own agent console covers most of its small screen; out of the way, the
  // screenshots show what a player would see.
  tryPs("minimize", "", "CASCADIA_HOSTING_WINDOW_CLASS")
  const probe = tryPs("windows")
  report.runner = { screen: tryPs("shot", join(EVIDENCE, "shots", "00-desktop-at-start.png"))?.screen ?? null, visibleWindows: probe?.map((w) => `${w.Process} | ${w.Class} | ${w.Title}`) ?? null }
  log(`runner desktop ${report.runner.screen}; visible windows: ${(report.runner.visibleWindows ?? []).join(" ; ")}`)
  // What the updater will read: the releases feed in its order, and where releases/latest points.
  try {
    const feed = await (await fetch("https://github.com/StratumServer/riftlauncher-update-test/releases.atom", { signal: AbortSignal.timeout(15_000) })).text()
    const latest = await fetch("https://github.com/StratumServer/riftlauncher-update-test/releases/latest", { redirect: "manual", signal: AbortSignal.timeout(15_000) })
    report.feed = { order: [...feed.matchAll(/releases\/tag\/([^"]+)"/g)].map((m) => m[1]), latest: latest.headers.get("location") }
    log(`releases feed order ${report.feed.order.join(", ")}; releases/latest -> ${report.feed.latest}`)
  } catch (error) {
    report.errors.push(`reading the releases feed: ${error.message}`)
  }
  startTrace()
  await installOld()
  seedProfile()
  if (scenario === "defer") await deferScenario()
  else await restartScenario()
}

let exitCode = 0
try {
  await main()
} catch (error) {
  fail(error.stack ?? String(error))
  exitCode = 1
} finally {
  for (const watcher of [...watchers]) await stopWatcher(watcher)
  await stopTrace()
  try {
    if (existsSync(join(P.userData, "Logs"))) cpSync(join(P.userData, "Logs"), join(EVIDENCE, "logs"), { recursive: true })
    report.updaterCacheAtEnd = listing(P.updaterCache)
    report.processesAtEnd = tryPs("procs")
    desktopShot("end")
  } catch (error) {
    report.errors.push(`collecting evidence: ${error.message}`)
  }
  const v = report.verdict
  const expected = scenario === "defer" ? ["offeredFirst", "offeredAgain", "downloadedVerified", "dataIntact"] : ["offered", "downloadedVerified", "installed", "restartedOn170", "dataIntact"]
  const missing = expected.filter((k) => v[k] !== true)
  if (scenario === "defer" && v.thirdLaunchVersion !== NEW_VERSION) missing.push("thirdLaunchVersion")
  if (missing.length) exitCode = 1
  report.finishedAt = new Date().toISOString()
  report.notAsExpected = missing
  save()
  const rows = Object.entries(v).map(([k, val]) => `| ${k} | ${JSON.stringify(val)} |`)
  const summary = [`### Scenario ${scenario} (receiveBetaUpdates ${report.receiveBetaUpdates})`, "", "| check | result |", "| --- | --- |", ...rows, "", report.errors.length ? `Errors: ${report.errors.length}, see report.json` : "No harness errors.", ""].join("\n")
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n")
  console.log(summary)
  process.exit(exitCode)
}
