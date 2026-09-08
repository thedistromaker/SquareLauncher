"use strict";

/**
 * Central, aggressive on-disk cache shared by every installer path
 * (vanilla, Fabric/Quilt, Forge/NeoForge). Everything lives under
 * <userDir>/cache and is split into a few independent categories so the
 * Settings > Caching screen can inspect/clear them individually:
 *
 *   cache/meta/        - JSON blobs for the version manifest, per-version
 *                         details, and mod loader metadata (fabric/quilt/
 *                         forge/neoforge), each stamped with a fetch time
 *                         so it can expire on its own TTL.
 *   cache/libraries/    - A single shared Maven-style library tree. Every
 *                         profile that needs "commons-io-2.11.jar" points
 *                         at the same cached copy instead of downloading
 *                         (and storing) it once per profile.
 *   cache/assets/       - Asset objects + asset indexes, keyed by hash and
 *                         by asset-index id (which is effectively "per
 *                         Minecraft version"). Installing five profiles on
 *                         1.20.1 downloads the 1.20.1 asset set exactly
 *                         once, not five times.
 *   cache/installers/   - Forge/NeoForge installer jars, keyed by exact
 *                         loader version (these never change once published).
 *
 * Every category can be toggled off independently from Settings; when off,
 * callers fall back to fetching directly with no caching, same as before
 * this feature existed.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const { fetchUA } = require("./http");

const DEFAULT_CACHE_SETTINGS = {
  checkVersions: true,
  versionsTTLHours: 24,
  modloaders: true,
  modloaderTTLHours: 12,
  libraries: true,
  assets: true,
};

let BASE_DIR = null;
let settingsGetter = () => DEFAULT_CACHE_SETTINGS;

function cacheRoot() {
  return path.join(BASE_DIR, "cache");
}
function metaDir() {
  return path.join(cacheRoot(), "meta");
}
function librariesDir() {
  return path.join(cacheRoot(), "libraries");
}
function assetsDir() {
  return path.join(cacheRoot(), "assets");
}
function assetObjectsDir() {
  return path.join(assetsDir(), "objects");
}
function assetIndexesDir() {
  return path.join(assetsDir(), "indexes");
}
function installersDir() {
  return path.join(cacheRoot(), "installers");
}

function init(baseDir, getSettings) {
  BASE_DIR = baseDir;
  if (typeof getSettings === "function") settingsGetter = getSettings;
  for (const dir of [metaDir(), librariesDir(), assetObjectsDir(), assetIndexesDir(), installersDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function settings() {
  return { ...DEFAULT_CACHE_SETTINGS, ...(settingsGetter() || {}) };
}

// ---------------------------------------------------------------------
// Generic TTL'd JSON/text cache (version manifest, version details,
// mod-loader metadata).
// ---------------------------------------------------------------------
function metaFile(key) {
  const safe = String(key).replace(/[^a-z0-9_.-]/gi, "_");
  return path.join(metaDir(), `${safe}.json`);
}

async function cachedFetch(key, url, { ttlHours, enabled, kind = "json" }) {
  const file = metaFile(key);
  if (enabled) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8"));
      const ageMs = Date.now() - raw.timestamp;
      if (ageMs < ttlHours * 3600 * 1000) return raw.data;
    } catch {
      /* no valid cache yet, fall through and fetch */
    }
  }

  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  const data = kind === "json" ? await res.json() : await res.text();

  try {
    fs.mkdirSync(metaDir(), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ timestamp: Date.now(), url, data }));
  } catch {
    /* best effort - cache write failures should never break installs */
  }
  return data;
}

function cachedVersionManifest(url) {
  const s = settings();
  return cachedFetch("version_manifest", url, {
    ttlHours: s.versionsTTLHours,
    enabled: s.checkVersions,
    kind: "json",
  });
}

function cachedVersionDetails(versionId, url) {
  const s = settings();
  // Once a release's version.json is published it never changes, so this
  // is safe to cache far longer than the manifest itself - but still
  // respects the same on/off switch as "check versions".
  return cachedFetch(`version_details_${versionId}`, url, {
    ttlHours: Math.max(s.versionsTTLHours, 24 * 30),
    enabled: s.checkVersions,
    kind: "json",
  });
}

function cachedLoaderJson(key, url) {
  const s = settings();
  return cachedFetch(`loader_${key}`, url, {
    ttlHours: s.modloaderTTLHours,
    enabled: s.modloaders,
    kind: "json",
  });
}

function cachedLoaderText(key, url) {
  const s = settings();
  return cachedFetch(`loader_${key}`, url, {
    ttlHours: s.modloaderTTLHours,
    enabled: s.modloaders,
    kind: "text",
  });
}

// ---------------------------------------------------------------------
// Shared file download helpers
// ---------------------------------------------------------------------
function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function fetchToPath(url, destPath) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);
  const tmp = `${destPath}.part-${process.pid}`;
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  fs.renameSync(tmp, destPath);
}

function linkOrCopy(src, dest) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    try {
      fs.unlinkSync(dest);
    } catch {
      /* fall through - copyFileSync below will overwrite it anyway */
    }
  }
  try {
    fs.linkSync(src, dest);
  } catch {
    fs.copyFileSync(src, dest);
  }
}

// ---------------------------------------------------------------------
// Shared library cache
// ---------------------------------------------------------------------
async function ensureLibraryCached(url, relPath, sha1) {
  const cachedPath = path.join(librariesDir(), relPath);
  if (fs.existsSync(cachedPath)) {
    if (!sha1) return cachedPath;
    try {
      if ((await sha1File(cachedPath)) === sha1) return cachedPath;
    } catch {
      /* corrupt cache entry - re-download below */
    }
  }
  await fetchToPath(url, cachedPath);
  return cachedPath;
}

// ---------------------------------------------------------------------
// Shared, per-Minecraft-version asset cache
// ---------------------------------------------------------------------
async function ensureAssetObjectCached(hash, url) {
  const sub = hash.substring(0, 2);
  const dest = path.join(assetObjectsDir(), sub, hash);
  if (fs.existsSync(dest)) return dest;
  await fetchToPath(url, dest);
  return dest;
}

function getCachedAssetIndex(id) {
  const file = path.join(assetIndexesDir(), `${id}.json`);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function cacheAssetIndex(id, json) {
  fs.mkdirSync(assetIndexesDir(), { recursive: true });
  fs.writeFileSync(path.join(assetIndexesDir(), `${id}.json`), JSON.stringify(json));
}

// ---------------------------------------------------------------------
// Forge/NeoForge installer jar cache (keyed by exact loader version)
// ---------------------------------------------------------------------
async function ensureInstallerCached(kind, loaderVersion, url) {
  const s = settings();
  const safeVersion = String(loaderVersion).replace(/[^a-z0-9_.-]/gi, "_");
  const cachedPath = path.join(installersDir(), `${kind}-${safeVersion}-installer.jar`);
  if (s.modloaders && fs.existsSync(cachedPath)) return cachedPath;
  await fetchToPath(url, cachedPath);
  return cachedPath;
}

// ---------------------------------------------------------------------
// Stats / clearing for the Settings > Caching screen
// ---------------------------------------------------------------------
function dirStats(dir) {
  let bytes = 0;
  let files = 0;
  function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name);
      if (ent.isDirectory()) walk(p);
      else {
        try {
          bytes += fs.statSync(p).size;
          files += 1;
        } catch {
          /* ignore races with in-flight downloads */
        }
      }
    }
  }
  walk(dir);
  return { bytes, files };
}

function getCacheStats() {
  const meta = dirStats(metaDir());
  const libraries = dirStats(librariesDir());
  const assets = dirStats(assetsDir());
  const installers = dirStats(installersDir());
  const total = {
    bytes: meta.bytes + libraries.bytes + assets.bytes + installers.bytes,
    files: meta.files + libraries.files + assets.files + installers.files,
  };
  return { meta, libraries, assets, installers, total };
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function clearCache(category) {
  const map = {
    meta: metaDir(),
    versions: metaDir(),
    modloaders: metaDir(),
    libraries: librariesDir(),
    assets: assetsDir(),
    installers: installersDir(),
  };
  if (category === "all") {
    for (const dir of [metaDir(), librariesDir(), assetsDir(), installersDir()]) rmrf(dir);
  } else if (map[category]) {
    rmrf(map[category]);
  } else {
    throw new Error(`Unknown cache category "${category}".`);
  }
  for (const dir of [metaDir(), librariesDir(), assetObjectsDir(), assetIndexesDir(), installersDir()]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return getCacheStats();
}

module.exports = {
  DEFAULT_CACHE_SETTINGS,
  init,
  settings,
  cachedVersionManifest,
  cachedVersionDetails,
  cachedLoaderJson,
  cachedLoaderText,
  ensureLibraryCached,
  ensureAssetObjectCached,
  getCachedAssetIndex,
  cacheAssetIndex,
  ensureInstallerCached,
  linkOrCopy,
  getCacheStats,
  clearCache,
};
