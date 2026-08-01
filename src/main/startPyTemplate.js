"use strict";

/**
 * Generates a self-contained start.py for a fetched version folder, in
 * the same shape as the hand-written scripts the launcher already knows
 * how to run (BASE/client.jar, BASE/libraries/**, BASE/assets, BASE/natives).
 *
 * Two credential modes:
 *  - "msa": a real Microsoft/Xbox/Minecraft session was active at fetch
 *    time, so the profile UUID and Minecraft access token (a JWT) are
 *    baked in directly.
 *  - "offline": no session was active, so the script falls back to a
 *    deterministic offline UUID derived from the username (uuid3, same
 *    algorithm the vanilla client uses for offline play) and a dummy
 *    access token, identical to the original hand-written scripts.
 *
 * Note: a baked-in Minecraft access token is short-lived (Mojang expires
 * them after a day or so). Square Launcher refreshes the --uuid/
 * --accessToken lines in this file right before each launch if a
 * Microsoft session is active - see patchCredentials() below - so the
 * embedded value here is really just the value at generation time.
 */

function pyStr(s) {
  return JSON.stringify(String(s));
}

function buildStartPy({
  mainClass,
  versionId,
  assetIndexId,
  versionType = "release",
  credentials, // { mode: "msa", uuid, accessToken } | { mode: "offline" }
}) {
  const credentialsBlock =
    credentials && credentials.mode === "msa"
      ? `
# Microsoft account was signed in when this file was generated.
FIXED_UUID = ${pyStr(credentials.uuid)}
FIXED_ACCESS_TOKEN = ${pyStr(credentials.accessToken)}
FIXED_USER_TYPE = "msa"

def _get_or_create_uuid(username: str) -> str:
    return FIXED_UUID

ACCESS_TOKEN = FIXED_ACCESS_TOKEN
USER_TYPE = FIXED_USER_TYPE
`.trim()
      : `
# No Microsoft account was signed in when this file was generated;
# falling back to a deterministic offline UUID, same as vanilla offline play.
def _get_or_create_uuid(username: str) -> str:
    if UUID_FILE.exists():
        stored = UUID_FILE.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    offline_uuid = str(uuid.uuid3(uuid.NAMESPACE_DNS, f"OfflinePlayer:{username}"))
    UUID_FILE.write_text(offline_uuid, encoding="utf-8")
    return offline_uuid

ACCESS_TOKEN = "0"
USER_TYPE = "legacy"
`.trim();

  return `import os
import sys
import subprocess
import uuid
from pathlib import Path

BASE = Path(__file__).resolve().parent
UUID_FILE = BASE / "uuid.txt"


def _resolve_jvm() -> Path:
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg.startswith("--jvm="):
            return Path(arg.split("=", 1)[1])
        if arg == "--jvm" and i + 1 < len(args):
            return Path(args[i + 1])
    env_jvm = os.environ.get("JVM")
    if env_jvm:
        return Path(env_jvm)
    return BASE / "jdk-26.0.1" / "bin" / "java"


JAVA = _resolve_jvm()
USERNAME = os.environ.get("USERNAME", "Player")

${credentialsBlock}

PERMUUID = _get_or_create_uuid(USERNAME)

classpath_entries: list[Path] = []
client_jar = BASE / "client.jar"
if client_jar.exists():
    classpath_entries.append(client_jar)
else:
    print(f"[err] client.jar not found at {client_jar}", flush=True)
    sys.exit(1)

libs_dir = BASE / "libraries"
if libs_dir.exists():
    classpath_entries.extend(sorted(libs_dir.rglob("*.jar")))
else:
    print(f"[err] libraries/ directory not found at {libs_dir}", flush=True)
    sys.exit(1)

classpath = os.pathsep.join(str(p) for p in classpath_entries)

jvm_args = [
    "-Xms512M",
    "-Xmx2G",
    "-Djava.awt.headless=false",
    f"-Djava.library.path={BASE / 'natives'}",
]

# Only required on macOS
if sys.platform == "darwin":
    jvm_args.insert(0, "-XstartOnFirstThread")

mc_args = [
    ${pyStr(mainClass)},
    "--username", USERNAME,
    "--version", ${pyStr(versionId)},
    "--gameDir", str(BASE),
    "--assetsDir", str(BASE / "assets"),
    "--assetIndex", ${pyStr(assetIndexId)},
    "--uuid", PERMUUID,
    "--accessToken", ACCESS_TOKEN,
    "--userType", USER_TYPE,
    "--versionType", ${pyStr(versionType)},
]

cmd = [
    str(JAVA),
    *jvm_args,
    "-cp", classpath,
    *mc_args,
]

try:
    result = subprocess.run(cmd, cwd=str(BASE))
    exit_code = result.returncode
except FileNotFoundError:
    print(f"[error] Java executable not found: {JAVA}", flush=True)
    print("        Set the JVM path in the launcher, or bundle a JDK in this version folder.", flush=True)
    sys.exit(1)

print()
print(f"Exit code: {exit_code}", flush=True)
`;
}

/**
 * Rewrites the --uuid / --accessToken / --userType lines of a previously
 * generated start.py in place, so a fresh Microsoft session is used on
 * the next launch without regenerating the whole file. No-ops safely if
 * the file wasn't generated with the "msa" credential block (nothing to
 * find/replace).
 */
function patchCredentials(startPyContents, { uuid, accessToken }) {
  let out = startPyContents;
  if (/FIXED_UUID = /.test(out)) {
    out = out.replace(/FIXED_UUID = ".*"/, `FIXED_UUID = ${pyStr(uuid)}`);
    out = out.replace(/FIXED_ACCESS_TOKEN = ".*"/, `FIXED_ACCESS_TOKEN = ${pyStr(accessToken)}`);
  }
  return out;
}

module.exports = { buildStartPy, patchCredentials };
