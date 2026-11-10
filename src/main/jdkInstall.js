"use strict";

/**
 * JDK downloads.
 *
 * 3.0.17 built Oracle "script-friendly" URLs:
 *   https://download.oracle.com/java/26/latest/jdk-26_windows-x64_bin.zip
 * Oracle retired those paths (they 404 now), and Java 26 is not an LTS
 * release, so those URLs also disappear as soon as the next update ships.
 *
 * This module uses the Adoptium (Eclipse Temurin) API instead, which is the
 * same OpenJDK build Prism/MultiMC and most modpacks use:
 *   https://api.adoptium.net/v3/binary/latest/<major>/ga/<os>/<arch>/jdk/hotspot/normal/eclipse
 * The API always redirects to a live GitHub release asset, so the URL can
 * never rot the way the Oracle path did. If a requested major version has no
 * build yet (e.g. asking for 26 before its GA), we fall back to the newest
 * available feature release and report the substitution instead of failing.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const { spawn } = require("child_process");
const extract = require("extract-zip");
const { fetchUA, fetchJson } = require("./http");

const ADOPTIUM = "https://api.adoptium.net/v3";

function platformToken() {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "mac";
  return "linux";
}

function archToken() {
  if (process.arch === "arm64") return "aarch64";
  if (process.arch === "arm") return "arm";
  if (process.arch === "ia32") return "x86";
  return "x64";
}

function archiveExtension() {
  return process.platform === "win32" ? ".zip" : ".tar.gz";
}

async function availableReleases() {
  try {
    return await fetchJson(`${ADOPTIUM}/info/available_releases`);
  } catch (err) {
    throw new Error(`Could not reach the Adoptium API: ${err.message}`);
  }
}

/**
 * Picks the feature release to download. Returns {feature, substituted}.
 */
async function resolveFeature(version) {
  const wanted = Number.parseInt(String(version), 10);
  const info = await availableReleases();
  const available = Array.isArray(info.available_releases) ? info.available_releases : [];
  if (!available.length) throw new Error("Adoptium returned no available Java releases.");

  if (available.includes(wanted)) return { feature: wanted, substituted: false };

  const lower = available.filter((v) => v <= wanted).sort((a, b) => b - a);
  const feature = lower[0] || available.slice().sort((a, b) => b - a)[0];
  return { feature, substituted: true, requested: wanted };
}

function binaryUrl(feature) {
  const os = platformToken();
  const arch = archToken();
  return `${ADOPTIUM}/binary/latest/${feature}/ga/${os}/${arch}/jdk/hotspot/normal/eclipse`;
}

function jdkBinaryPath(destDir) {
  if (process.platform === "win32") return path.join(destDir, "bin", "java.exe");
  if (process.platform === "darwin") return path.join(destDir, "Contents", "Home", "bin", "java");
  return path.join(destDir, "bin", "java");
}

function jdkDir(baseDir, version) {
  return path.join(baseDir, `jdk-${version}`);
}

function listInstalledJdks(baseDir) {
  const out = [];
  if (!fs.existsSync(baseDir)) return out;
  for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^jdk-/.test(entry.name)) continue;
    const dir = path.join(baseDir, entry.name);
    const binaryPath = jdkBinaryPath(dir);
    if (!fs.existsSync(binaryPath)) continue;
    out.push({ version: entry.name.replace(/^jdk-/, ""), path: binaryPath, dir });
  }
  return out.sort((a, b) => Number(b.version) - Number(a.version));
}

async function downloadFile(url, destPath, onProgress) {
  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Download failed (${res.status}) from ${url}`);
  const totalBytes = Number(res.headers.get("content-length")) || 0;
  let receivedBytes = 0;

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.on("data", (chunk) => {
      receivedBytes += chunk.length;
      if (onProgress) {
        const percent = totalBytes ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : null;
        onProgress({ receivedBytes, totalBytes, percent });
      }
    });
    res.body.on("error", reject);
    res.body.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const proc = spawn("tar", ["-xzf", archivePath, "-C", destDir]);
    let stderr = "";
    proc.stderr.on("data", (chunk) => (stderr += chunk.toString()));
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}: ${stderr}`))));
  });
}

async function installJdkVersion(baseDir, version, onLog, onProgress, forceReinstall = false, isFallback = false) {
  const log = (line) => onLog && onLog(line);
  const progress = (info) => onProgress && onProgress(info);

  const { feature, substituted } = await resolveFeature(version);
  const shownVersion = String(feature);
  const destDir = jdkDir(baseDir, shownVersion);
  const archivePath = path.join(baseDir, `jdk${shownVersion}_download${archiveExtension()}`);
  const tempExtract = path.join(baseDir, "jdk_temp_extract");

  const existingBinary = jdkBinaryPath(destDir);
  if (!forceReinstall && fs.existsSync(existingBinary)) {
    log(`[JDK] Temurin ${shownVersion} is already installed — skipping download.\n`);
    progress({ phase: "done", percent: 100, cached: true, feature });
    return { binaryPath: existingBinary, feature, substituted };
  }

  if (substituted) {
    log(
      `[JDK] No Adoptium build exists for Java ${version} yet — installing the newest available ` +
        `release (Temurin ${feature}) instead.\n`
    );
  }

  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
  await fsp.mkdir(baseDir, { recursive: true });

  const url = binaryUrl(feature);
  log(`[JDK] Downloading Eclipse Temurin ${shownVersion} (${platformToken()}/${archToken()})…\n`);
  progress({ phase: "download", percent: 0, feature });
  try {
    await downloadFile(url, archivePath, (info) => progress({ phase: "download", ...info }));
  } catch (err) {
    if (fs.existsSync(archivePath)) fs.rmSync(archivePath, { force: true });
    const info = isFallback ? null : await availableReleases().catch(() => null);
    const fallback = info && info.most_recent_feature_release;
    if (fallback && String(fallback) !== String(feature)) {
      log(`[JDK] Temurin ${feature} could not be downloaded (${err.message}). Retrying with ${fallback}.\n`);
      return installJdkVersion(baseDir, String(fallback), onLog, onProgress, true, true);
    }
    throw err;
  }
  log("[JDK] Download complete. Extracting…\n");
  progress({ phase: "extract", percent: null });

  if (archiveExtension() === ".zip") {
    await extract(archivePath, { dir: tempExtract });
  } else {
    await extractTarGz(archivePath, tempExtract);
  }

  const subdirs = (await fsp.readdir(tempExtract, { withFileTypes: true })).filter((d) => d.isDirectory());
  if (subdirs.length) {
    await fsp.rename(path.join(tempExtract, subdirs[0].name), destDir);
  } else {
    await fsp.rename(tempExtract, destDir);
  }

  if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });
  if (fs.existsSync(archivePath)) fs.rmSync(archivePath);

  const binaryPath = jdkBinaryPath(destDir);
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`The JDK archive extracted but no java executable was found at ${binaryPath}.`);
  }

  progress({ phase: "done", percent: 100, feature });
  log(`[JDK] Installed Temurin ${shownVersion}. Runtime path: ${binaryPath}\n`);
  return { binaryPath, feature, substituted };
}

module.exports = {
  installJdkVersion,
  listInstalledJdks,
  jdkBinaryPath,
  jdkDir,
  resolveFeature,
  binaryUrl,
  platformToken,
  archToken,
};
