"use strict";

const fs = require("fs");
const path = require("path");

function currentOsName() {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
}

function currentArch() {
  if (process.arch === "arm64") return "arm64";
  if (process.arch === "arm") return "arm";
  if (process.arch === "ia32") return "x86";
  return "x64";
}

function rulesAllow(rules, extras = {}) {
  if (!rules || !rules.length) return true;
  const osName = currentOsName();
  const arch = currentArch();
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os) {
      if (rule.os.name && rule.os.name !== osName) matches = false;
      if (rule.os.arch && rule.os.arch !== arch) matches = false;
    }
    if (rule.features) {
      for (const [feat, want] of Object.entries(rule.features)) {
        const have = !!extras[feat];
        if (have !== !!want) matches = false;
      }
    }
    if (matches) allowed = rule.action === "allow";
  }
  return allowed;
}

function mavenCoordToPath(coord) {
  const [raw, ext] = String(coord).split("@");
  const parts = raw.split(":");
  const [group, artifact, version, classifier] = parts;
  const groupPath = group.replace(/\./g, "/");
  const extension = ext || "jar";
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.${extension}`
    : `${artifact}-${version}.${extension}`;
  return `${groupPath}/${artifact}/${version}/${fileName}`;
}

function libraryPathOf(lib) {
  if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
    return lib.downloads.artifact.path;
  }
  if (lib.name) return mavenCoordToPath(lib.name);
  return null;
}

function isNativeLibrary(lib) {
  if (lib.natives) return true;
  const name = lib.name || "";
  return /:natives-/.test(name) || /natives-/.test((lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) || "");
}

function librariesForLaunch(libraries) {
  return (libraries || []).filter((lib) => {
    if (!lib || !lib.name) return false;
    if (!rulesAllow(lib.rules)) return false;
    if (isNativeLibrary(lib)) return false;
    return true;
  });
}

function collectArgEntries(list, extras) {
  const out = [];
  for (const item of list || []) {
    if (typeof item === "string") {
      out.push(item);
      continue;
    }
    if (!item || typeof item !== "object") continue;
    if (item.rules && !rulesAllow(item.rules, extras)) continue;
    const value = item.value;
    if (Array.isArray(value)) out.push(...value);
    else if (typeof value === "string") out.push(value);
  }
  return out;
}

function interpolate(str, vars) {
  return String(str).replace(/\$\{([^}]+)\}/g, (_, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) return vars[key];
    return `\${${key}}`;
  });
}

function mergeProfiles(base, overlay) {
  if (!overlay) return JSON.parse(JSON.stringify(base));
  const merged = JSON.parse(JSON.stringify(base));
  if (overlay.mainClass) merged.mainClass = overlay.mainClass;
  if (overlay.type) merged.type = overlay.type;
  if (overlay.id) merged.id = overlay.id;
  if (overlay.minecraftArguments) merged.minecraftArguments = overlay.minecraftArguments;
  merged.libraries = [...(overlay.libraries || []), ...(base.libraries || [])];

  const baseArgs = base.arguments || {};
  const overArgs = overlay.arguments || {};
  merged.arguments = {
    jvm: [...(overArgs.jvm || []), ...(baseArgs.jvm || [])],
    game: [...(overArgs.game || []), ...(baseArgs.game || [])],
  };
  if (overlay.minecraftArguments && !overArgs.game) {
    merged.arguments.game = overlay.minecraftArguments.split(" ").concat(merged.arguments.game || []);
  }
  return merged;
}

/**
 * Builds a launch plan from a Mojang/Forge/Fabric launcher profile JSON.
 * Paths in the returned plan stay relative to the version folder so start.py
 * can keep working as a standalone 1.0-compatible script.
 */
function buildLaunchPlan(profile, { versionDir, versionId, username = "Player" } = {}) {
  const librariesDir = path.join(versionDir, "libraries");
  const nativesDir = path.join(versionDir, "natives");
  const assetsDir = path.join(versionDir, "assets");
  const sep = path.delimiter;

  const launchLibs = librariesForLaunch(profile.libraries);
  const relJars = [];
  const seen = new Set();

  const usesSlimOrExtra = launchLibs.some((lib) => /:(slim|extra)$/.test(lib.name || ""));
  if (!usesSlimOrExtra) {
    const clientJar = path.join(versionDir, "client.jar");
    if (fs.existsSync(clientJar)) {
      relJars.push("client.jar");
      seen.add("client.jar");
    }
  }

  for (const lib of launchLibs) {
    const rel = libraryPathOf(lib);
    if (!rel) continue;
    const key = rel.replace(/\\/g, "/");
    if (seen.has(key)) continue;
    seen.add(key);
    relJars.push(path.join("libraries", key).replace(/\\/g, "/"));
  }

  const extras = { is_demo_user: false, has_custom_resolution: false };
  let jvmRaw;
  let gameRaw;
  if (profile.arguments) {
    jvmRaw = collectArgEntries(profile.arguments.jvm, extras);
    gameRaw = collectArgEntries(profile.arguments.game, extras);
  } else {
    jvmRaw = [
      "-Djava.library.path=${natives_directory}",
      "-Dminecraft.launcher.brand=${launcher_name}",
      "-Dminecraft.launcher.version=${launcher_version}",
      "-cp",
      "${classpath}",
    ];
    gameRaw = (profile.minecraftArguments || "").split(" ").filter(Boolean);
  }

  // Path placeholders are left for start.py so the folder stays relocatable
  // (same contract as SquareLauncher 1.0 zip packages).
  const vars = {
    auth_player_name: username,
    auth_uuid: "OFFLINE_UUID",
    auth_access_token: "0",
    user_type: "legacy",
    user_properties: "{}",
    version_name: versionId || profile.id || "unknown",
    assets_index_name: (profile.assetIndex && profile.assetIndex.id) || profile.assets || "legacy",
    launcher_name: "SquareLauncher",
    launcher_version: "3.0.0",
    classpath_separator: sep,
    version_type: profile.type || "release",
    resolution_width: "854",
    resolution_height: "480",
  };

  const jvmArgs = [];
  for (let i = 0; i < jvmRaw.length; i++) {
    const token = interpolate(jvmRaw[i], vars);
    if (token === "-cp" || token === "-classpath") {
      i += 1;
      continue;
    }
    jvmArgs.push(token);
  }

  if (!jvmArgs.some((a) => a.startsWith("-Xmx"))) {
    jvmArgs.unshift("-Xmx2G", "-Xms512M");
  }
  if (process.platform === "darwin" && !jvmArgs.includes("-XstartOnFirstThread")) {
    jvmArgs.unshift("-XstartOnFirstThread");
  }
  if (!jvmArgs.some((a) => a.startsWith("-Djava.library.path="))) {
    jvmArgs.push(`-Djava.library.path=${nativesDir}`);
  }

  const gameArgs = gameRaw.map((t) => interpolate(t, vars));

  return {
    mainClass: profile.mainClass,
    jvmArgs,
    gameArgs,
    classpathRel: relJars,
    nativesDir,
    assetsIndexId: vars.assets_index_name,
    versionType: vars.version_type,
    usesSlimOrExtra,
  };
}

function loadProfile(versionDir) {
  const profilePath = path.join(versionDir, "profile.json");
  const versionPath = path.join(versionDir, "version.json");
  if (fs.existsSync(profilePath)) {
    return JSON.parse(fs.readFileSync(profilePath, "utf-8"));
  }
  if (fs.existsSync(versionPath)) {
    return JSON.parse(fs.readFileSync(versionPath, "utf-8"));
  }
  return null;
}

module.exports = {
  currentOsName,
  rulesAllow,
  mavenCoordToPath,
  libraryPathOf,
  librariesForLaunch,
  mergeProfiles,
  buildLaunchPlan,
  loadProfile,
  isNativeLibrary,
};
