"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, spawnSync, execFile } = require("child_process");
const { patchCredentials } = require("./startPyTemplate");
const { loadProfile, buildLaunchPlan } = require("./launchProfile");
const { buildStartPyFromPlan } = require("./startPyTemplate");

/**
 * start.py is a Python script, not a Node/Electron script, so it must be
 * run through an actual Python interpreter rather than process.execPath
 * (which points at Node/Electron and can't load .py files at all).
 * Tries a few common interpreter names/paths and caches whichever works.
 */
let cachedPythonCmd = null;

function resolvePythonCommand() {
  if (cachedPythonCmd) return cachedPythonCmd;

  const candidates =
    process.platform === "win32" ? ["python", "py"] : ["python3", "python"];

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
    if (fs.existsSync(jvmPath + ".exe")) jvmPath = jvmPath + ".exe";
    else {
      const javaw = path.join(path.dirname(jvmPath), "javaw.exe");
      if (fs.existsSync(javaw)) jvmPath = javaw;
    }
  }
  return jvmPath;
}

/**
 * If this version was generated with an embedded Microsoft session and a
 * session is currently active, refresh the --uuid/--accessToken values in
 * start.py right before launch (Minecraft access tokens are short-lived).
 * No-op for zip installs or offline-mode versions.
 */
function refreshCredentialsIfNeeded(versionDir, session) {
  const startPath = path.join(versionDir, "start.py");
  if (!fs.existsSync(startPath) || !session || !session.ownsGame || !session.profile) return;

  const contents = fs.readFileSync(startPath, "utf-8");
  const patched = patchCredentials(contents, {
    uuid: session.profile.id,
    accessToken: session.minecraftAccessToken,
  });
  if (patched !== contents) fs.writeFileSync(startPath, patched, "utf-8");
}

/**
 * Log patterns that mean "wrong-architecture native library" - the classic
 * symptom on arm64 machines that got x86_64 LWJGL/GLFW binaries. Depending
 * on the JDK/platform this can throw a clean exception, or it can wedge
 * native init so the process just sits there forever with no window and
 * no further output, which is what shows up to a user as "it hangs". Either
 * way we want to catch it and tell the user what's wrong instead of
 * leaving them staring at a launcher that looks frozen.
 */
const ARCH_MISMATCH_PATTERNS = [
  /UnsatisfiedLinkError/i,
  /Platform\/architecture mismatch/i,
  /wrong ELF class/i,
  /cannot open shared object file/i,
  /no lwjgl in java\.library\.path/i,
  /Failed to locate library/i,
];

// If nothing at all is printed this long after spawning, treat it as
// hung rather than leaving the user waiting indefinitely. Generous on
// purpose - slow ARM SBCs can legitimately take a while to get going -
// this is a last-resort safety net, not the primary fix.
const SILENT_HANG_TIMEOUT_MS = 120_000;

/**
 * Launches any profile - zip-installed, vanilla, Fabric, or Quilt - by
 * running its start.py, passing the resolved JVM path the same way the
 * original launcher did.
 */
function launchVersion({ entry, username, jvmGlobal, session, onLog }) {
  const versionDir = entry.path;

  if (entry.source === "microsoft") {
    refreshCredentialsIfNeeded(versionDir, session);
  }

  const start = path.join(versionDir, "start.py");
  if (!fs.existsSync(start)) throw new Error(`Could not find startup script at:\n${start}`);

  const jvmSetting = entry.jvm || jvmGlobal;
  if (!jvmSetting) throw new Error("No Java runtime configured.");
  const jvmPath = resolveJvmPath(jvmSetting, versionDir);
  if (!fs.existsSync(jvmPath)) throw new Error(`Could not find Java at:\n${jvmPath}`);

  const pythonCmd = resolvePythonCommand();
  const env = { ...process.env, USERNAME: username, JVM: jvmPath };
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

module.exports = { testJava, launchVersion };
