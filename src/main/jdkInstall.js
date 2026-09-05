"use strict";

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const zlib = require("zlib");
const tar = require("child_process"); // we shell out to `tar` for .tar.gz (present on macOS/Linux)
const extract = require("extract-zip");
const fetch = require("node-fetch");

function jdkDownloadUrl(version) {
  // Oracle's "script-friendly" URLs resolve to the latest update for a
  // given major version (e.g. 24, 25, 26). Construct the platform-specific
  // download URL for the requested version.
  const arch = process.arch; // "x64" or "arm64"
  const v = String(version);
  if (process.platform === "win32") {
    return { url: `https://download.oracle.com/java/${v}/latest/jdk-${v}_windows-x64_bin.zip`, ext: ".zip" };
  } else if (process.platform === "darwin") {
    const macArch = arch === "arm64" ? "aarch64" : "x64";
    return {
      url: `https://download.oracle.com/java/${v}/latest/jdk-${v}_macos-${macArch}_bin.tar.gz`,
      ext: ".tar.gz",
    };
  }
  const linuxArch = arch === "arm64" ? "aarch64" : "x64";
  return {
    url: `https://download.oracle.com/java/${v}/latest/jdk-${v}_linux-${linuxArch}_bin.tar.gz`,
    ext: ".tar.gz",
  };
}

async function downloadFile(url, destPath, onProgress) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);

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
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function extractTarGz(archivePath, destDir) {
  return new Promise((resolve, reject) => {
    fs.mkdirSync(destDir, { recursive: true });
    const proc = tar.spawn("tar", ["-xzf", archivePath, "-C", destDir]);
    proc.on("error", reject);
    proc.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`tar exited ${code}`))));
  });
}

async function installJdkVersion(baseDir, version, onLog, onProgress) {
  const { url, ext } = jdkDownloadUrl(version);
  const destDir = path.join(baseDir, `jdk-${version}`);
  const archivePath = path.join(baseDir, `jdk${version}_download${ext}`);
  const tempExtract = path.join(baseDir, "jdk_temp_extract");

  if (fs.existsSync(destDir)) fs.rmSync(destDir, { recursive: true, force: true });
  if (fs.existsSync(tempExtract)) fs.rmSync(tempExtract, { recursive: true, force: true });

  onLog && onLog(`[Download] Starting OpenJDK ${version} retrieval task sequence...\n`);
  onProgress && onProgress({ phase: "download", percent: 0 });
  await downloadFile(url, archivePath, (info) => {
    onProgress && onProgress({ phase: "download", ...info });
  });
  onLog && onLog("[Download] Package archive downloaded successfully. Extracting assets...\n");
  onProgress && onProgress({ phase: "extract", percent: null });

  if (ext === ".zip") {
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

  let binaryPath;
  if (process.platform === "win32") binaryPath = path.join(destDir, "bin", "java.exe");
  else if (process.platform === "darwin") binaryPath = path.join(destDir, "Contents", "Home", "bin", "java");
  else binaryPath = path.join(destDir, "bin", "java");

  onProgress && onProgress({ phase: "done", percent: 100 });
  onLog && onLog(`[Download] Finished! Auto-configured runtime path pointer to: ${binaryPath}\n`);
  return binaryPath;
}

module.exports = { installJdkVersion };
