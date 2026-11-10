"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");
const { loadProfile, buildLaunchPlan } = require("./launchProfile");
const { buildStartPyFromPlan } = require("./startPyTemplate");

const MIN_MEMORY_MB = 2048;
const RESERVED_MEMORY_MB = 1024;
const MEMORY_STEP_MB = 256;

/** Heap slider bounds: 2048 MiB up to (system RAM - 1024 MiB). */
function memoryBounds() {
  const totalMb = Math.floor(os.totalmem() / 1024 / 1024);
  // Hard cap is exactly system RAM - 1024 MiB, per the profile settings spec.
  const max = Math.max(MIN_MEMORY_MB, totalMb - RESERVED_MEMORY_MB);
  const suggested = Math.min(max, Math.max(MIN_MEMORY_MB, Math.floor((totalMb * 0.5) / MEMORY_STEP_MB) * MEMORY_STEP_MB));
  return { min: MIN_MEMORY_MB, max, step: MEMORY_STEP_MB, totalMb, suggested };
}

function clampMemory(value) {
  const bounds = memoryBounds();
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return bounds.suggested;
  return Math.min(bounds.max, Math.max(bounds.min, Math.round(n / bounds.step) * bounds.step));
}

/**
 * start.py is a Python script, not a Node/Electron script, so it must be run
 * through an actual Python interpreter rather than process.execPath.
 */
let cachedPythonCmd = null;

function resolvePythonCommand() {
  if (cachedPythonCmd) return cachedPythonCmd;
  const candidates = process.platform === "win32" ? ["python", "py"] : ["python3", "python"];
  for (const candidate of candidates) {
    const result = spawnSync(candidate, ["--version"], { windowsHide: true });
    if (!result.error && result.status === 0) {
      cachedPythonCmd = candidate;
      return candidate;
    }
  }
  throw new Error(
    "Could not find a Python interpreter (tried: " +
      candidates.join(", ") +
      "). Please install Python 3 and make sure it's on your PATH."
  );
}

function testJava(javaPath) {
  return new Promise((resolve) => {
    execFile(javaPath, ["-version"], (err, stdout, stderr) => {
      resolve({ ok: !err, output: (stderr || "") + (stdout || "") + (err ? String(err) : "") });
    });
  });
}

function resolveJvmPath(jvmSetting, versionDir) {
  let jvmPath = path.isAbsolute(jvmSetting) ? jvmSetting : path.resolve(versionDir, jvmSetting);
  if (process.platform === "win32" && !path.extname(jvmPath)) {
    if (fs.existsSync(`${jvmPath}.exe`)) jvmPath += ".exe";
    else {
      const javaw = path.join(path.dirname(jvmPath), "javaw.exe");
      if (fs.existsSync(javaw)) jvmPath = javaw;
    }
  }
  return jvmPath;
}

/**
 * Regenerates start.py from profile.json so per-profile memory/JVM args take
 * effect. Zip-packaged profiles ship their own start.py and are left alone.
 */
function regenerateStartPy(versionDir, { username, versionId, memoryMb, extraJvmArgs }) {
  const profile = loadProfile(versionDir);
  if (!profile || !profile.mainClass) return false;
  const plan = buildLaunchPlan(profile, { versionDir, versionId, username });
  const script = buildStartPyFromPlan(plan, { versionId, memoryMb, extraJvmArgs });
  fs.writeFileSync(path.join(versionDir, "start.py"), script, "utf-8");
  return true;
}

const ARCH_MISMATCH_PATTERNS = [
  /UnsatisfiedLinkError/i,
  /Platform\/architecture mismatch/i,
  /wrong ELF class/i,
  /cannot open shared object file/i,
  /no lwjgl in java\.library\.path/i,
  /Failed to locate library/i,
];

const SILENT_HANG_TIMEOUT_MS = 120_000;

function launchVersion({ entry, profileName, username, jvmGlobal, memoryMb, extraJvmArgs, onLog }) {
  const versionDir = entry.path;
  const start = path.join(versionDir, "start.py");
  const isZipProfile = entry.source === "zip";

  if (!isZipProfile) {
    try {
      regenerateStartPy(versionDir, {
        username: username || "Player",
        versionId: entry.versionId || profileName || path.basename(versionDir),
        memoryMb,
        extraJvmArgs: extraJvmArgs ? [extraJvmArgs] : [],
      });
    } catch (err) {
      onLog && onLog(`[warn] Could not refresh start.py: ${err.message}\n`);
    }
  }

  if (!fs.existsSync(start)) throw new Error(`Could not find startup script at:\n${start}`);

  const jvmSetting = entry.javaPath || entry.jvm || jvmGlobal;
  if (!jvmSetting) throw new Error("No Java runtime configured. Install a JDK in Settings → Java.");
  const jvmPath = resolveJvmPath(jvmSetting, versionDir);
  if (!fs.existsSync(jvmPath)) throw new Error(`Could not find Java at:\n${jvmPath}`);

  const pythonCmd = resolvePythonCommand();
  const env = { ...process.env, USERNAME: username || "Player", JVM: jvmPath };
  if (memoryMb) env.CUBOID_MEMORY_MB = String(memoryMb);
  if (extraJvmArgs) env.CUBOID_JVM_ARGS = String(extraJvmArgs);

  const child = spawn(pythonCmd, [start, `--jvm=${jvmPath}`], {
    cwd: versionDir,
    env,
    windowsHide: true,
  });

  pipeOutput(child, onLog);
  return child;
}

function pipeOutput(child, onLog) {
  let settled = false;
  let hangTimer = null;
  const say = (text) => onLog && onLog(text);

  const armHint =
    process.arch === "arm64" ? " (common on arm64 when native libraries don't match this CPU)" : "";

  const resetHangTimer = () => {
    clearTimeout(hangTimer);
    hangTimer = setTimeout(() => {
      if (settled) return;
      settled = true;
      say(`\n[warn] No output from Java in 2 minutes - this looks hung${armHint}. Stopping it.\n`);
      child.kill();
    }, SILENT_HANG_TIMEOUT_MS);
  };
  resetHangTimer();

  const watch = (chunk) => {
    const text = chunk.toString();
    say(text);
    if (settled) return;
    resetHangTimer();
    if (ARCH_MISMATCH_PATTERNS.some((re) => re.test(text))) {
      settled = true;
      clearTimeout(hangTimer);
      say(
        `\n[error] Detected a native-library architecture mismatch${armHint}. Stopping the game ` +
          "instead of letting it hang - try reinstalling this version so the launcher can fetch " +
          "matching native libraries.\n"
      );
      child.kill();
    }
  };

  child.stdout.on("data", watch);
  child.stderr.on("data", watch);
  child.on("close", (code) => {
    settled = true;
    clearTimeout(hangTimer);
    say(`\n[Exit ${code}]\n`);
  });
}

module.exports = {
  testJava,
  launchVersion,
  memoryBounds,
  clampMemory,
  regenerateStartPy,
  MIN_MEMORY_MB,
  RESERVED_MEMORY_MB,
};
