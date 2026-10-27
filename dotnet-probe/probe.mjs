// Starts a .NET GUI app whose runtime is missing the way RiftLauncher starts Vintage Story
// (gameHandlers.ts: spawn with shell false and windowsHide true), then reports whether the
// process is still alive after a while, which windows it owns, and whether stderr carries the
// .NET host's missing-runtime sentence.
import { execFileSync, spawn } from "node:child_process"
import { mkdirSync, readdirSync } from "node:fs"
import { dirname, join } from "node:path"

const [exe, outDir] = process.argv.slice(2)
mkdirSync(outDir, { recursive: true })
const dataRoot = join(outDir, "data")
const SENTINEL = "You must install or update .NET to run this application."
const WAIT_MS = 10_000

const cases = [
  { name: "launcher-as-is", windowsHide: true, env: {} },
  { name: "windowsHide-false", windowsHide: false, env: {} },
  { name: "launcher-with-DOTNET_DISABLE_GUI_ERRORS", windowsHide: true, env: { DOTNET_DISABLE_GUI_ERRORS: "1" } }
]

// PROBE_CASES narrows the run to a comma-separated list of case names.
const only = process.env.PROBE_CASES?.split(",")
const results = []
for (const c of cases.filter((entry) => !only || only.includes(entry.name))) {
  // An empty data folder per case, as a new Installation's is, so what the game writes there shows.
  const dataPath = join(dataRoot, c.name)
  mkdirSync(dataPath, { recursive: true })
  const child = spawn(exe, [`--dataPath=${dataPath}`, ""], { env: { ...process.env, ...c.env }, cwd: dirname(exe), shell: false, windowsHide: c.windowsHide })
  let stderr = ""
  let exitCode = null
  let closed = false
  child.stdout.resume()
  child.stderr.on("data", (data) => (stderr += data.toString()))
  child.on("close", (code) => {
    closed = true
    exitCode = code
  })
  await new Promise((resolve) => setTimeout(resolve, WAIT_MS))
  const powershell = (script, ...args) => {
    try {
      return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", join(import.meta.dirname, script), ...args], { timeout: 30_000 }).toString()
    } catch (error) {
      return `${script} failed: ${error.message.split("\n")[0]}`
    }
  }
  const windows = closed ? [] : powershell("windows.ps1", String(child.pid)).trim().split(/\r?\n/).filter(Boolean)
  powershell("screenshot.ps1", join(outDir, `${c.name}.png`))
  results.push({ case: c.name, stillRunningAfter10s: !closed, exitCode, dataFolderAfter10s: readdirSync(dataPath), sentinelOnStderr: stderr.includes(SENTINEL), windows, stderrHead: stderr.slice(0, 800) })
  if (!closed) {
    child.kill()
    await new Promise((resolve) => setTimeout(resolve, 1_000))
  }
}
console.log(JSON.stringify(results, null, 2))
