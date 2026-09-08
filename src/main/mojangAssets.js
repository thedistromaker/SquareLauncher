"use strict";

/**
 * Fetches version metadata and game assets from Mojang's public metadata
 * service, then optionally layers Fabric, Quilt, Forge, or NeoForge.
 *
 * Each installed version is a self-contained folder compatible with
 * SquareLauncher 1.0 (start.py) and 2.x (client.jar + libraries + assets).
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const extract = require("extract-zip");

const { fetchUA } = require("./http");
const { resolveLoader } = require("./loaderMeta");
const { buildStartPyFromPlan } = require("./startPyTemplate");
const { applyNativeOverrideIfNeeded } = require("./archNatives");
const { mergeProfiles, buildLaunchPlan, currentOsName, rulesAllow, isNativeLibrary } = require("./launchProfile");
const { installForgeLike } = require("./forgeInstall");
const cache = require("./cacheManager");

const VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

async function getVersionManifest() {
  try {
    return await cache.cachedVersionManifest(VERSION_MANIFEST_URL);
  } catch (err) {
    throw new Error(`Could not reach version manifest (${err.message}).`);
  }
}

async function getVersionDetails(versionMeta) {
  try {
    return await cache.cachedVersionDetails(versionMeta.id, versionMeta.url);
  } catch (err) {
    throw new Error(`Could not fetch version details for ${versionMeta.id}: ${err.message}`);
  }
}

function sha1File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha1");
    const stream = fs.createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

async function downloadToFile(url, destPath, expectedSha1) {
  await fsp.mkdir(path.dirname(destPath), { recursive: true });

  if (fs.existsSync(destPath) && expectedSha1) {
    try {
      if ((await sha1File(destPath)) === expectedSha1) return;
    } catch {
      /* fall through to re-download */
    }
  }

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

function librariesForCurrentOS(libraries) {
  // Delegate to the same rules evaluator start.py/launchProfile uses, which
  // also checks `rule.os.arch` - not just `rule.os.name`. Without the arch
  // check, an arm64 macOS machine (for example) would pass both the x64 and
  // the arm64 natives entries for a given library, since only the OS name
  // was ever being compared.
  return (libraries || []).filter((lib) => lib && rulesAllow(lib.rules));
}

async function downloadVanillaLibraries(libraries, librariesDir, onProgress) {
  const withArtifacts = librariesForCurrentOS(libraries).filter((l) => l.downloads && l.downloads.artifact && l.downloads.artifact.url);
  const useCache = cache.settings().libraries;
  for (let i = 0; i < withArtifacts.length; i++) {
    const lib = withArtifacts[i];
    onProgress && onProgress(i + 1, withArtifacts.length, lib.name);
    const art = lib.downloads.artifact;
    const destPath = path.join(librariesDir, art.path);
    if (useCache) {
      const cachedPath = await cache.ensureLibraryCached(art.url, art.path, art.sha1);
      cache.linkOrCopy(cachedPath, destPath);
    } else {
      await downloadToFile(art.url, destPath, art.sha1);
    }
  }
}

async function downloadNatives(libraries, versionDir, onProgress) {
  const platform = currentOsName();
  const nativesDir = path.join(versionDir, "natives");
  await fsp.mkdir(nativesDir, { recursive: true });

  const forCurrentOs = librariesForCurrentOS(libraries);

  // Legacy scheme (Minecraft versions before Mojang reworked natives
  // delivery): a library carries a `natives` map keyed by OS name, pointing
  // at a same-library `downloads.classifiers[...]` entry.
  const legacyNatives = forCurrentOs.filter(
    (l) => l.natives && l.natives[platform] && l.downloads && l.downloads.classifiers
  );

  // Modern scheme: the native build is its own top-level library entry
  // (gated by `rules`, identified by a "natives-<os>[-<arch>]" suffix on
  // its name/path) with a plain `downloads.artifact`, not a `classifiers`
  // map. `downloadVanillaLibraries` already fetches this jar into
  // `libraries/` like any other dependency, but never extracted it into
  // `natives/`, so the actual .so/.dll/.dylib files never made it onto
  // java.library.path - the game would build and launch fine and then die
  // in LWJGL's native bootstrap ("Failed to locate library: liblwjgl.so")
  // on every platform/architecture, not just the arm64 case archNatives.js
  // handles. Skip anything already claimed by the legacy branch above so a
  // library never gets extracted twice.
  const modernNatives = forCurrentOs.filter(
    (l) =>
      isNativeLibrary(l) &&
      !(l.natives && l.downloads && l.downloads.classifiers) &&
      l.downloads &&
      l.downloads.artifact &&
      l.downloads.artifact.url
  );

  const jobs = [
    ...legacyNatives.map((lib) => {
      const classifier = lib.downloads.classifiers[lib.natives[platform]];
      return { name: lib.name, url: classifier && classifier.url, sha1: classifier && classifier.sha1 };
    }),
    ...modernNatives.map((lib) => ({
      name: lib.name,
      url: lib.downloads.artifact.url,
      sha1: lib.downloads.artifact.sha1,
    })),
  ];

  const useCache = cache.settings().libraries;
  for (let i = 0; i < jobs.length; i++) {
    const job = jobs[i];
    onProgress && onProgress(i + 1, jobs.length, job.name);
    if (!job.url) continue;

    let jarPath;
    if (useCache) {
      const relPath = `natives/${String(job.name).replace(/[^a-z0-9_.-]/gi, "_")}.jar`;
      jarPath = await cache.ensureLibraryCached(job.url, relPath, job.sha1);
    } else {
      jarPath = path.join(versionDir, ".tmp-natives", `${i}.jar`);
      await downloadToFile(job.url, jarPath, job.sha1);
    }
    try {
      await extract(jarPath, { dir: nativesDir });
    } catch {
      /* best-effort */
    }
  }

  const tmpDir = path.join(versionDir, ".tmp-natives");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function downloadAssets(assetIndexMeta, versionDir, onProgress) {
  const useCache = cache.settings().assets;

  // "Per version, not whenever it wants": the asset index id is tied
  // directly to the Minecraft version, so a cache hit here means the
  // exact same asset set this version has always used - never a stale
  // or mismatched one.
  let assetIndex = useCache ? cache.getCachedAssetIndex(assetIndexMeta.id) : null;
  if (!assetIndex) {
    const assetIndexRes = await fetchUA(assetIndexMeta.url);
    assetIndex = await assetIndexRes.json();
    if (useCache) cache.cacheAssetIndex(assetIndexMeta.id, assetIndex);
  }

  const assetsDir = path.join(versionDir, "assets");
  const indexesDir = path.join(assetsDir, "indexes");
  await fsp.mkdir(indexesDir, { recursive: true });
  await fsp.writeFile(path.join(indexesDir, `${assetIndexMeta.id}.json`), JSON.stringify(assetIndex));

  const entries = Object.entries(assetIndex.objects || {});
  for (let i = 0; i < entries.length; i++) {
    const [name, obj] = entries[i];
    if (i % 25 === 0 || i === entries.length - 1) onProgress && onProgress(i + 1, entries.length, name);
    const sub = obj.hash.substring(0, 2);
    const url = `https://resources.download.minecraft.net/${sub}/${obj.hash}`;
    const destPath = path.join(assetsDir, "objects", sub, obj.hash);
    if (useCache) {
      const cachedPath = await cache.ensureAssetObjectCached(obj.hash, url);
      cache.linkOrCopy(cachedPath, destPath);
    } else {
      await downloadToFile(url, destPath, obj.hash);
    }
  }

  return assetIndex;
}

async function downloadLoaderLibraries(loaderLibraries, librariesDir, onProgress) {
  const useCache = cache.settings().libraries;
  for (let i = 0; i < loaderLibraries.length; i++) {
    const lib = loaderLibraries[i];
    onProgress && onProgress(i + 1, loaderLibraries.length, lib.name);
    const destPath = path.join(librariesDir, lib.path);
    if (useCache) {
      const cachedPath = await cache.ensureLibraryCached(lib.url, lib.path, null);
      cache.linkOrCopy(cachedPath, destPath);
    } else {
      await downloadToFile(lib.url, destPath);
    }
  }
}

function writeStartPy(destDir, profile, versionId) {
  const plan = buildLaunchPlan(profile, { versionDir: destDir, versionId, username: "Player" });
  const startPy = buildStartPyFromPlan(plan, {
    versionId,
    credentials: { mode: "offline" },
  });
  fs.writeFileSync(path.join(destDir, "start.py"), startPy, "utf-8");
  return plan;
}

async function installVersion(versionId, destDir, loaderKind, loaderVersion, _session, onProgress, javaPath) {
  const notify = (stage, extra = {}) => onProgress && onProgress({ stage, ...extra });
  const kind = loaderKind || "vanilla";

  notify("manifest");
  const manifest = await getVersionManifest();
  const meta = manifest.versions.find((v) => v.id === versionId);
  if (!meta) throw new Error(`Unknown version "${versionId}".`);

  notify("version_details");
  const details = await getVersionDetails(meta);

  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(path.join(destDir, "version.json"), JSON.stringify(details, null, 2));
  await fsp.writeFile(path.join(destDir, "profile.json"), JSON.stringify(details, null, 2));

  notify("client_jar");
  const clientDl = details.downloads.client;
  await downloadToFile(clientDl.url, path.join(destDir, "client.jar"), clientDl.sha1);

  const librariesDir = path.join(destDir, "libraries");
  notify("libraries");
  await downloadVanillaLibraries(details.libraries, librariesDir, (current, total, label) =>
    notify("libraries", { current, total, label })
  );

  notify("natives");
  await downloadNatives(details.libraries, destDir, (current, total, label) =>
    notify("natives", { current, total, label })
  );

  notify("natives_arch_check");
  const nativeOverride = await applyNativeOverrideIfNeeded(details.libraries, destDir, (current, total, label) =>
    notify("natives_arch_fix", { current, total, label })
  );
  if (nativeOverride.warning) notify("natives_arch_warning", { message: nativeOverride.warning });

  notify("asset_index");
  await downloadAssets(details.assetIndex, destDir, (current, total, label) =>
    notify("assets", { current, total, label })
  );

  let resolvedLoaderVersion = null;
  let launchProfile = details;

  if (kind === "fabric" || kind === "quilt") {
    notify("loader_resolve", { label: kind });
    const loader = await resolveLoader(kind, versionId, loaderVersion);
    resolvedLoaderVersion = loader.loaderVersion;
    launchProfile = mergeProfiles(details, loader.profile);
    await fsp.writeFile(path.join(destDir, "profile.json"), JSON.stringify(launchProfile, null, 2));

    notify("loader_libraries", { label: kind });
    await downloadLoaderLibraries(loader.libraries, librariesDir, (current, total, label) =>
      notify("loader_libraries", { current, total, label })
    );
  } else if (kind === "forge" || kind === "neoforge") {
    if (!loaderVersion) {
      throw new Error(`Pick a ${kind} version before installing.`);
    }
    const result = await installForgeLike({
      kind,
      mcVersion: versionId,
      loaderVersion,
      destDir,
      javaPath,
      onLog: (line) => notify("loader_log", { message: line }),
      onProgress,
    });
    resolvedLoaderVersion = result.loaderVersion;
    launchProfile = mergeProfiles(details, result.profile);
    await fsp.writeFile(path.join(destDir, "profile.json"), JSON.stringify(launchProfile, null, 2));
  }

  notify("writing_start_script");
  const plan = writeStartPy(destDir, launchProfile, versionId);

  notify("done");
  return {
    path: destDir,
    mainClass: plan.mainClass,
    assetIndexId: details.assetIndex.id,
    versionId,
    loader: kind,
    loaderVersion: resolvedLoaderVersion,
    credentialMode: "offline",
    nativeOverride,
  };
}

async function listAvailableVersions(typeFilter = ["release"]) {
  const manifest = await getVersionManifest();
  return manifest.versions
    .filter((v) => typeFilter.includes(v.type))
    .map((v) => ({ id: v.id, type: v.type, releaseTime: v.releaseTime }));
}

module.exports = {
  getVersionManifest,
  listAvailableVersions,
  installVersion,
  writeStartPy,
};
