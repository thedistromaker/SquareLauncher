"use strict";

/**
 * Installs Forge or NeoForge on top of a vanilla SquareLauncher profile.
 *
 * The installer JAR contains version.json (the launcher profile — JVM args,
 * mainClass, libraries including slim/extra client jars) and
 * install_profile.json (processors that actually split/patch those jars).
 *
 * We run the official installer in --installClient mode so slim/extra jars
 * are produced the same way Prism/the vanilla launcher would.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const extract = require("extract-zip");
const { fetchUA } = require("./http");
const { forgeInstallerUrl, neoForgeInstallerUrl } = require("./loaderMeta");

async function downloadToFile(url, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function runJava(javaPath, args, cwd, onLog) {
  return new Promise((resolve, reject) => {
    const child = spawn(javaPath, args, { cwd, windowsHide: true });
    let out = "";
    child.stdout.on("data", (c) => {
      out += c.toString();
      onLog && onLog(c.toString());
    });
    child.stderr.on("data", (c) => {
      out += c.toString();
      onLog && onLog(c.toString());
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve(out);
      else reject(new Error(`Installer exited ${code}\n${out.slice(-4000)}`));
    });
  });
}

function findJsonInDir(root, predicate) {
  const hits = [];
  function walk(dir) {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.endsWith(".json") && predicate(p, ent.name)) hits.push(p);
    }
  }
  walk(root);
  return hits;
}

async function extractInstallerProfile(installerJar, extractDir) {
  await extract(installerJar, { dir: extractDir });
  const versionJsonPath = path.join(extractDir, "version.json");
  const installProfilePath = path.join(extractDir, "install_profile.json");
  if (!fs.existsSync(versionJsonPath)) {
    throw new Error("Installer is missing version.json (launcher profile).");
  }
  const profile = JSON.parse(fs.readFileSync(versionJsonPath, "utf-8"));
  const installProfile = fs.existsSync(installProfilePath)
    ? JSON.parse(fs.readFileSync(installProfilePath, "utf-8"))
    : null;
  return { profile, installProfile };
}

function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, ent.name);
    const to = path.join(dest, ent.name);
    if (ent.isDirectory()) copyDirContents(from, to);
    else {
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
  }
}

/**
 * @param {"forge"|"neoforge"} kind
 * @param {string} mcVersion
 * @param {string} loaderVersion  full maven version (forge: 1.20.1-47.3.0, neo: 21.1.66)
 * @param {string} destDir        SquareLauncher version folder (already has vanilla client/assets)
 * @param {string} javaPath
 */
async function installForgeLike({ kind, mcVersion, loaderVersion, destDir, javaPath, onLog, onProgress }) {
  const notify = (stage, extra = {}) => onProgress && onProgress({ stage, ...extra });
  const say = (line) => onLog && onLog(line);

  if (!javaPath || !fs.existsSync(javaPath)) {
    throw new Error("Forge/NeoForge install needs a working Java runtime. Install one in Settings first.");
  }

  const url = kind === "neoforge" ? neoForgeInstallerUrl(loaderVersion) : forgeInstallerUrl(loaderVersion);
  const installerJar = path.join(destDir, `.${kind}-installer.jar`);
  notify("loader_resolve", { label: kind });
  say(`[${kind}] Downloading installer ${loaderVersion}\n`);
  await downloadToFile(url, installerJar);

  const extractDir = path.join(destDir, `.${kind}-installer-extract`);
  if (fs.existsSync(extractDir)) fs.rmSync(extractDir, { recursive: true, force: true });
  fs.mkdirSync(extractDir, { recursive: true });
  const { profile, installProfile } = await extractInstallerProfile(installerJar, extractDir);

  await fsp.writeFile(path.join(destDir, "profile.json"), JSON.stringify(profile, null, 2));
  if (installProfile) {
    await fsp.writeFile(path.join(destDir, "install_profile.json"), JSON.stringify(installProfile, null, 2));
  }

  // Official installer expects a vanilla-launcher .minecraft tree.
  const staging = path.join(destDir, ".forge-staging");
  if (fs.existsSync(staging)) fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(path.join(staging, "versions", mcVersion), { recursive: true });
  fs.writeFileSync(path.join(staging, "launcher_profiles.json"), JSON.stringify({ profiles: {} }));

  const vanillaJson = path.join(destDir, "version.json");
  if (fs.existsSync(vanillaJson)) {
    fs.copyFileSync(vanillaJson, path.join(staging, "versions", mcVersion, `${mcVersion}.json`));
  }
  const clientJar = path.join(destDir, "client.jar");
  if (fs.existsSync(clientJar)) {
    fs.copyFileSync(clientJar, path.join(staging, "versions", mcVersion, `${mcVersion}.jar`));
  }
  copyDirContents(path.join(destDir, "libraries"), path.join(staging, "libraries"));

  notify("loader_libraries", { label: kind });
  say(`[${kind}] Running installer (this produces slim/extra jars)…\n`);

  const attempts = [
    ["-jar", installerJar, "--installClient", staging],
    ["-jar", installerJar, "--installClient", staging, "--offline"],
  ];
  let lastErr = null;
  for (const args of attempts) {
    try {
      await runJava(javaPath, args, staging, say);
      lastErr = null;
      break;
    } catch (err) {
      lastErr = err;
    }
  }
  if (lastErr) throw lastErr;

  // Merge installer libraries (slim/extra/universal/…) back into the profile folder.
  copyDirContents(path.join(staging, "libraries"), path.join(destDir, "libraries"));

  const stagedVersions = path.join(staging, "versions");
  const profileHits = findJsonInDir(stagedVersions, (p, name) => {
    return name !== `${mcVersion}.json` && !name.includes("installer");
  });
  if (profileHits.length) {
    const produced = JSON.parse(fs.readFileSync(profileHits[0], "utf-8"));
    await fsp.writeFile(path.join(destDir, "profile.json"), JSON.stringify(produced, null, 2));
  }

  fs.rmSync(staging, { recursive: true, force: true });
  fs.rmSync(extractDir, { recursive: true, force: true });
  try {
    fs.rmSync(installerJar, { force: true });
  } catch {
    /* ignore */
  }

  const finalProfile = JSON.parse(fs.readFileSync(path.join(destDir, "profile.json"), "utf-8"));
  return {
    profile: finalProfile,
    loaderVersion,
    mainClass: finalProfile.mainClass,
  };
}

module.exports = { installForgeLike };
