"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { app, shell } = require("electron");
const { fetchUA, fetchText } = require("./http");

const REMOTE_VERSION_URL = "https://cdn.jsdelivr.net/gh/thedistromaker/SquareLauncher@main/version.txt";
const UPDATES_MD = "https://github.com/thedistromaker/SquareLauncher/blob/main/UPDATES.md";
const RELEASE_DOWNLOAD_BASE = "https://github.com/thedistromaker/SquareLauncher/releases/latest/download";

function readLocalVersion() {
  const candidates = [
    path.join(process.resourcesPath || "", "version.txt"),
    path.join(__dirname, "..", "..", "version.txt"),
    path.join(app.getAppPath(), "version.txt"),
  ];
  for (const p of candidates) {
    try {
      if (p && fs.existsSync(p)) {
        const n = parseFloat(fs.readFileSync(p, "utf-8").trim());
        if (!Number.isNaN(n)) return n;
      }
    } catch {
      /* next */
    }
  }
  try {
    const pkg = require("../../package.json");
    if (pkg.launcherVersion != null) return Number(pkg.launcherVersion);
  } catch {
    /* ignore */
  }
  return 33;
}

async function fetchRemoteVersion() {
  const text = (await fetchText(REMOTE_VERSION_URL)).trim();
  const n = parseFloat(text);
  if (Number.isNaN(n)) throw new Error(`Remote version.txt was not a number: ${text}`);
  return n;
}

function detectInstallType() {
  if (process.env.APPIMAGE || /\.AppImage$/i.test(process.execPath)) return "appimage";
  if (process.platform === "win32") return "nsis";
  if (process.platform === "darwin") return "dmg";
  if (process.platform === "linux") {
    const exec = process.execPath;
    try {
      const { spawnSync } = require("child_process");
      const dpkg = spawnSync("dpkg", ["-S", exec], { encoding: "utf-8" });
      if (dpkg.status === 0 && dpkg.stdout) return "deb";
    } catch {
      /* ignore */
    }
    try {
      const { spawnSync } = require("child_process");
      const rpm = spawnSync("rpm", ["-qf", exec], { encoding: "utf-8" });
      if (rpm.status === 0 && rpm.stdout && !/not owned/i.test(rpm.stdout)) return "rpm";
    } catch {
      /* ignore */
    }
    if (exec.includes("/opt/") || exec.includes("/usr/")) return "deb";
    return "unknown";
  }
  return "unknown";
}

function archToken() {
  return process.arch === "arm64" ? "arm64" : "amd64";
}

function releaseDownloadUrl(installType) {
  if (installType === "deb") return `${RELEASE_DOWNLOAD_BASE}/SquareLauncher-${archToken()}.deb`;
  if (installType === "rpm") return `${RELEASE_DOWNLOAD_BASE}/SquareLauncher-${archToken()}.rpm`;
  if (installType === "nsis") return `${RELEASE_DOWNLOAD_BASE}/SquareLauncher-${archToken()}.exe`;
  return null;
}

async function downloadAsset(url, destPath, onProgress) {
  const res = await fetchUA(url, { headers: { Accept: "application/octet-stream" } });
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get("content-length")) || 0;
  let received = 0;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.on("data", (chunk) => {
      received += chunk.length;
      onProgress && onProgress({ received, total, percent: total ? Math.round((received / total) * 100) : null });
    });
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function runPrivileged(cmd, args) {
  return new Promise((resolve, reject) => {
    const helper = fs.existsSync("/usr/bin/pkexec") ? "pkexec" : "sudo";
    const child = spawn(helper, [cmd, ...args], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(out || `exit ${code}`))));
  });
}

async function applyLinuxUpdate(installType, filePath) {
  if (installType === "deb") {
    await runPrivileged("apt", ["install", "-y", filePath]);
    return "Installed the DEB package. Restart SquareLauncher.";
  }
  if (installType === "rpm") {
    try {
      await runPrivileged("dnf", ["install", "-y", filePath]);
    } catch {
      await runPrivileged("rpm", ["-Uvh", filePath]);
    }
    return "Installed the RPM package. Restart SquareLauncher.";
  }
  throw new Error("Unknown Linux install type.");
}

async function applyWindowsUpdate(filePath) {
  await shell.openPath(filePath);
  return "Opened the Windows installer. Follow its prompts to update SquareLauncher.";
}

async function checkForUpdate() {
  const local = readLocalVersion();
  let remote;
  try {
    remote = await fetchRemoteVersion();
  } catch (err) {
    return { local, remote: null, updateAvailable: false, error: err.message, installType: detectInstallType() };
  }
  return {
    local,
    remote,
    updateAvailable: remote > local,
    installType: detectInstallType(),
    platform: process.platform,
  };
}

async function performUpdate(onProgress) {
  const installType = detectInstallType();
  const url = releaseDownloadUrl(installType);
  if (!url) {
    await shell.openExternal(UPDATES_MD);
    return { openedDocs: true, url: UPDATES_MD, reason: `Updates are not supported for ${installType}.` };
  }
  const extension = installType === "nsis" ? "exe" : installType;
  const dest = path.join(app.getPath("temp"), `SquareLauncher-${archToken()}.${extension}`);
  onProgress && onProgress({ phase: "download", percent: 0 });
  await downloadAsset(url, dest, (info) => onProgress && onProgress({ phase: "download", ...info }));
  onProgress && onProgress({ phase: "install", installType });
  const message = installType === "nsis" ? await applyWindowsUpdate(dest) : await applyLinuxUpdate(installType, dest);
  return { openedDocs: false, message, installType };
}

module.exports = { checkForUpdate, performUpdate, readLocalVersion, detectInstallType, releaseDownloadUrl, UPDATES_MD };
