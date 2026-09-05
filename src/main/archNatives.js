"use strict";

/**
 * Mojang's version manifests only ever ship x86_64 natives for Linux and
 * Windows, and only started shipping proper arm64 natives for macOS with
 * Minecraft 1.19. Every other OS/arch combination - arm64 Linux (Raspberry
 * Pi, Asahi, etc.), arm64 Windows, and macOS arm64 on versions older than
 * 1.19 - gets the *same* x86_64 ".so"/".dll"/".dylib" files as everyone
 * else, because Mojang's per-library "natives" map only ever has one entry
 * per OS name; it has no idea arm64 exists.
 *
 * Loading an x86_64 shared library into an arm64 JVM doesn't fail cleanly -
 * depending on the platform and JDK, it can throw immediately, or it can
 * wedge GLFW/JVM native init into a state where the process never produces
 * a window and never exits, which is what actually shows up to a user as
 * "the launcher hangs".
 *
 * The fix real-world launchers (Prism Launcher, MultiMC's arm forks, the
 * fix-lwjgl project, etc.) use is to bypass Mojang's copy entirely for the
 * arm64 case and pull the *same* LWJGL version straight from Maven Central,
 * which has published real arm64 natives for every LWJGL module since
 * 3.2.3 (linux/macos) and later versions (windows). Reading the version
 * straight out of the vanilla version.json's own "org.lwjgl:*" library
 * entries means we always match whatever LWJGL build that particular
 * Minecraft release actually wants - nothing hardcoded per MC version.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const fetch = require("node-fetch");
const extract = require("extract-zip");

const MAVEN_CENTRAL = "https://repo1.maven.org/maven2";

/** Node's process.arch -> the arch token LWJGL/Maven Central classifiers use. */
function currentLwjglArch() {
  switch (process.arch) {
    case "arm64":
      return "arm64";
    case "arm":
      return "arm32";
    default:
      return null; // x64/ia32 are exactly what Mojang already serves correctly
  }
}

/** Mojang's OS name -> the OS token LWJGL/Maven Central classifiers use ("osx" -> "macos"). */
function lwjglOsToken(mojangOsName) {
  if (mojangOsName === "osx") return "macos";
  return mojangOsName; // "linux" and "windows" already match
}

/**
 * True only when we're on an arch Mojang doesn't natively support at all
 * (arm64/arm32). Regular x64 machines never need this override.
 */
function needsNativeOverride() {
  return currentLwjglArch() !== null;
}

/**
 * Pulls every "org.lwjgl:<module>[:...]" library out of a vanilla
 * version.json's libraries array and returns { module, version } pairs,
 * deduped by module. This is "whatever LWJGL version this Minecraft
 * release wants" - read directly from Mojang's own metadata rather than
 * guessed or hardcoded.
 */
function findLwjglModules(vanillaLibraries) {
  const modules = new Map();
  let usesLegacyLwjgl2 = false;

  for (const lib of vanillaLibraries || []) {
    if (!lib || !lib.name) continue;
    const parts = lib.name.split(":");
    const [group, artifact, version] = parts;
    if (group === "org.lwjgl.lwjgl" || group === "net.java.jinput") {
      // LWJGL 2 (pre-1.13 Minecraft). Maven Central has no arm64 builds
      // of LWJGL 2 at all - there's nothing legitimate to fetch here.
      usesLegacyLwjgl2 = true;
      continue;
    }
    if (group === "org.lwjgl" && artifact && version) {
      modules.set(artifact, version);
    }
  }

  return {
    modules: Array.from(modules, ([module, version]) => ({ module, version })),
    usesLegacyLwjgl2,
  };
}

async function downloadBuffer(url) {
  const res = await fetch(url);
  if (res.status === 404) return null; // not every module ships every classifier
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.buffer();
}

/**
 * Downloads and extracts the arm64 (or arm32) native jar for one LWJGL
 * module from Maven Central, overwriting whatever x86_64 files Mojang's
 * own download already put in the natives folder.
 */
async function fetchAndExtractModule({ module, version, osToken, archToken, nativesDir, tmpDir }) {
  const classifier = `natives-${osToken}-${archToken}`;
  const fileName = `${module}-${version}-${classifier}.jar`;
  const url = `${MAVEN_CENTRAL}/org/lwjgl/${module}/${version}/${fileName}`;

  const buf = await downloadBuffer(url);
  if (!buf) return { module, ok: false, reason: "no arm build published for this version" };

  const tmpJar = path.join(tmpDir, fileName);
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.writeFile(tmpJar, buf);

  try {
    await extract(tmpJar, { dir: nativesDir });
  } catch {
    return { module, ok: false, reason: "downloaded jar could not be extracted" };
  }
  return { module, ok: true };
}

/**
 * Replaces Mojang's x86_64 LWJGL natives with the correct-architecture
 * build for the current machine, matched to the exact LWJGL version this
 * Minecraft release uses. No-op (returns applied:false) on regular x64
 * machines, since Mojang already gets that case right.
 */
async function applyNativeOverrideIfNeeded(vanillaLibraries, versionDir, onProgress) {
  const archToken = currentLwjglArch();
  if (!archToken) return { applied: false };

  const osToken = lwjglOsToken(
    process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux"
  );

  const { modules, usesLegacyLwjgl2 } = findLwjglModules(vanillaLibraries);

  if (usesLegacyLwjgl2 && modules.length === 0) {
    return {
      applied: false,
      warning:
        "This version of Minecraft uses LWJGL 2, which was never built for arm64/arm32. " +
        "arm64 native support needs Minecraft 1.13 or newer (LWJGL 3).",
    };
  }

  if (modules.length === 0) {
    return { applied: false };
  }

  const nativesDir = path.join(versionDir, "natives");
  const tmpDir = path.join(versionDir, ".tmp-arch-natives");
  await fsp.mkdir(nativesDir, { recursive: true });

  const results = [];
  for (let i = 0; i < modules.length; i++) {
    const { module, version } = modules[i];
    onProgress && onProgress(i + 1, modules.length, module);
    results.push(await fetchAndExtractModule({ module, version, osToken, archToken, nativesDir, tmpDir }));
  }

  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });

  const failed = results.filter((r) => !r.ok);
  return {
    applied: true,
    arch: archToken,
    os: osToken,
    lwjglVersion: modules[0].version,
    fetched: results.filter((r) => r.ok).map((r) => r.module),
    skipped: failed.map((r) => ({ module: r.module, reason: r.reason })),
  };
}

module.exports = {
  needsNativeOverride,
  findLwjglModules,
  applyNativeOverrideIfNeeded,
};
