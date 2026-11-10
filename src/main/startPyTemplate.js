"use strict";

/**
 * Generates a self-contained start.py for a version folder.
 *
 * start.py is run as `python start.py --jvm=<path>` with USERNAME in the
 * environment. JVM flags, main class, game args and classpath come from the
 * folder's launcher profile.json.
 *
 * 4.0 adds per-profile memory: the requested heap is baked in at launch time
 * (and also honoured from CUBOID_MEMORY_MB for hand-edited scripts), so the
 * profile slider actually controls -Xmx instead of being ignored.
 */

function pyStr(s) {
  return JSON.stringify(String(s));
}

function pyList(arr) {
  return "[" + arr.map((x) => pyStr(x)).join(", ") + "]";
}

function buildStartPyFromPlan(plan, { versionId, memoryMb, extraJvmArgs = [] } = {}) {
  const classpathRel = plan.classpathRel || [];
  const jvmTemplate = (plan.jvmArgs || []).map((arg) => String(arg).replace(/\\/g, "/"));
  const memory = Number.parseInt(memoryMb, 10);
  const bakedMemory = Number.isFinite(memory) && memory > 0 ? memory : 0;

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


def _get_or_create_uuid(username: str) -> str:
    if UUID_FILE.exists():
        stored = UUID_FILE.read_text(encoding="utf-8").strip()
        if stored:
            return stored
    offline_uuid = str(uuid.uuid3(uuid.NAMESPACE_DNS, f"OfflinePlayer:{username}"))
    UUID_FILE.write_text(offline_uuid, encoding="utf-8")
    return offline_uuid


PERMUUID = _get_or_create_uuid(USERNAME)
ACCESS_TOKEN = "0"
USER_TYPE = "legacy"

classpath_rel = ${pyList(classpathRel)}
classpath_entries = []
for rel in classpath_rel:
    p = BASE / rel
    if p.exists():
        classpath_entries.append(p)

# 1.0 zip packages sometimes only ship a named jar + start.py
if not classpath_entries:
    client_jar = BASE / "client.jar"
    if client_jar.exists():
        classpath_entries.append(client_jar)
    named = BASE / (${pyStr(versionId)} + ".jar")
    if named.exists():
        classpath_entries.append(named)
    libs_dir = BASE / "libraries"
    if libs_dir.exists():
        classpath_entries.extend(sorted(libs_dir.rglob("*.jar")))

if not classpath_entries:
    print("[err] No classpath jars found. This profile is incomplete.", flush=True)
    sys.exit(1)

classpath = os.pathsep.join(str(p) for p in classpath_entries)

def _rewrite(arg: str) -> str:
    out = arg
    out = out.replace("\${natives_directory}", str(BASE / "natives"))
    out = out.replace("\${game_directory}", str(BASE))
    out = out.replace("\${assets_root}", str(BASE / "assets"))
    out = out.replace("\${library_directory}", str(BASE / "libraries"))
    out = out.replace("\${auth_player_name}", USERNAME)
    out = out.replace("\${auth_uuid}", PERMUUID)
    out = out.replace("\${auth_access_token}", ACCESS_TOKEN)
    out = out.replace("\${user_type}", USER_TYPE)
    out = out.replace("\${user_properties}", "{}")
    out = out.replace("\${classpath}", classpath)
    return out

jvm_args = []
for raw in ${pyList(jvmTemplate)}:
    jvm_args.append(_rewrite(raw))

# Per-profile memory from the launcher, with an env override for hand tuning.
_override = os.environ.get("CUBOID_MEMORY_MB", "").strip()
if _override.isdigit():
    _memory_mb = int(_override)
else:
    _memory_mb = ${bakedMemory}

if _memory_mb >= 512:
    jvm_args = [a for a in jvm_args if not (a.startswith("-Xmx") or a.startswith("-Xms"))]
    _xms = min(max(_memory_mb // 2, 512), _memory_mb)
    jvm_args.insert(0, f"-Xmx{_memory_mb}M")
    jvm_args.insert(0, f"-Xms{_xms}M")

for _extra in ${pyList(extraJvmArgs)}:
    if _extra and _extra not in jvm_args:
        jvm_args.append(_extra)

# Force natives + game dir to this folder even if install-time paths differ.
jvm_args = [a for a in jvm_args if not a.startswith("-Djava.library.path=")]
jvm_args.append(f"-Djava.library.path={BASE / 'natives'}")

# Expose Java 21+ modules for Forge compatibility (log4j, etc.)
jvm_args.append("--add-modules=ALL-SYSTEM")
jvm_args.append("--add-opens=java.base/java.lang=ALL-UNNAMED")

if sys.platform == "darwin" and "-XstartOnFirstThread" not in jvm_args:
    jvm_args.insert(0, "-XstartOnFirstThread")

game_args = []
for raw in ${pyList(plan.gameArgs || [])}:
    game_args.append(_rewrite(raw))

# Always stamp identity / paths used by every Minecraft version we support,
# including 1.0 zip packages that only knew --username/--uuid.
def _ensure_pair(flag, value):
    if flag in game_args:
        i = game_args.index(flag)
        if i + 1 < len(game_args):
            game_args[i + 1] = value
            return
    game_args.extend([flag, value])

_ensure_pair("--username", USERNAME)
_ensure_pair("--uuid", PERMUUID)
_ensure_pair("--accessToken", ACCESS_TOKEN)
_ensure_pair("--userType", USER_TYPE)
_ensure_pair("--gameDir", str(BASE))
_ensure_pair("--assetsDir", str(BASE / "assets"))

cmd = [str(JAVA), *jvm_args, "-cp", classpath, ${pyStr(plan.mainClass)}, *game_args]

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

module.exports = { buildStartPyFromPlan };
