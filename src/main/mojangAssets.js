"use strict";

/**
 * Fetches version metadata and game assets from Mojang's public,
 * unauthenticated metadata service, and optionally layers a Fabric or
 * Quilt loader on top (see loaderMeta.js - Forge is intentionally not
 * supported, its install process is a different shape entirely).
 *
 * Each installed version is a self-contained folder:
 *   <name>/client.jar
 *   <name>/libraries/**\/*.jar
 *   <name>/natives/**
 *   <name>/assets/indexes/<id>.json, assets/objects/xx/<hash>
 *   <name>/start.py         <- generated, ready to run standalone
 *
 * No Microsoft/Mojang credentials are required to read this metadata;
 * Microsoft sign-in (msAuth.js) only supplies the UUID/access token used
 * to personalize the generated start.py.
 */

const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const crypto = require("crypto");
const fetch = require("node-fetch");
const extract = require("extract-zip");

const { resolveLoader } = require("./loaderMeta");
const { buildStartPy } = require("./startPyTemplate");

const VERSION_MANIFEST_URL = "https://launchermeta.mojang.com/mc/game/version_manifest_v2.json";

async function getVersionManifest() {
  const res = await fetch(VERSION_MANIFEST_URL);
  if (!res.ok) throw new Error(`Could not reach version manifest (${res.status}).`);
  return res.json();
}

async function getVersionDetails(versionMeta) {
  const res = await fetch(versionMeta.url);
  if (!res.ok) throw new Error(`Could not fetch version details for ${versionMeta.id}.`);
  return res.json();
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

  const res = await fetch(url);
  if (!res.ok) throw new Error(`Failed to download ${url} (${res.status})`);

  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
}

function currentOsName() {
  return process.platform === "win32" ? "windows" : process.platform === "darwin" ? "osx" : "linux";
}

/**
 * Mojang's version manifests gate modern LWJGL builds (1.19+) on both os.name
 * AND os.arch - there's a separate library entry per (os, arch) pair, e.g.
 * "natives-linux" vs "natives-linux-arm64". Node reports arm64 as "arm64" on
 * every platform (mac, linux, and Windows-on-ARM), which matches Mojang's
 * own rule value, so no further translation is needed.
 */
function currentArchName() {
  return process.arch === "arm64" ? "arm64" : process.arch;
}

function librariesForCurrentOS(libraries) {
  const platform = currentOsName();
  const arch = currentArchName();
  return libraries.filter((lib) => {
    if (!lib.rules) return true;
    let allowed = false;
    for (const rule of lib.rules) {
      const osMatches =
        !rule.os ||
        ((!rule.os.name || rule.os.name === platform) && (!rule.os.arch || rule.os.arch === arch));
      if (rule.action === "allow" && osMatches) allowed = true;
      if (rule.action === "disallow" && osMatches) allowed = false;
    }
    return allowed;
  });
}

/** Downloads a vanilla library into <versionDir>/libraries/<maven path>. */
async function downloadVanillaLibraries(libraries, librariesDir, onProgress) {
  const withArtifacts = librariesForCurrentOS(libraries).filter((l) => l.downloads && l.downloads.artifact);
  for (let i = 0; i < withArtifacts.length; i++) {
    const lib = withArtifacts[i];
    onProgress && onProgress(i + 1, withArtifacts.length, lib.name);
    const art = lib.downloads.artifact;
    await downloadToFile(art.url, path.join(librariesDir, art.path), art.sha1);
  }
}

function parseLibraryName(name) {
  // "org.lwjgl:lwjgl:3.3.3" or, for a natives variant, "org.lwjgl:lwjgl:3.3.3:natives-linux-arm64"
  const [group, artifact, version, classifier = null] = String(name).split(":");
  return { group, artifact, version, classifier };
}

const LWJGL_CORE_ARM64_CLASSIFIER = {
  linux: "natives-linux-arm64",
  osx: "natives-macos-arm64",
  windows: "natives-windows-arm64",
};

/**
 * Every LWJGL submodule (lwjgl-glfw, lwjgl-openal, lwjgl-opengl, lwjgl-stb,
 * lwjgl-tinyfd, ...) ships an arm64 native classifier in Mojang's version
 * manifest, and those are exactly what the generic os/arch rule filtering
 * above will now pick up. But the *core* org.lwjgl:lwjgl artifact - the one
 * that actually contains liblwjgl.so/.dylib/lwjgl.dll, the JNI bridge every
 * other LWJGL module calls into - is missing its arm64 build from the
 * manifest for a number of Minecraft versions. Nothing loads without it
 * (UnsatisfiedLinkError: no lwjgl in java.library.path), even though every
 * submodule downloaded fine. If we're on arm64 and the manifest doesn't
 * already carry that artifact, fetch it directly from Maven Central,
 * using the version number off a sibling submodule (they're always
 * released in lockstep with the core module).
 */
async function ensureLwjglCoreArm64Native(libraries, librariesDir, platform, arch, onProgress) {
  if (arch !== "arm64") return;
  const classifier = LWJGL_CORE_ARM64_CLASSIFIER[platform];
  if (!classifier) return;

  const parsed = libraries.map((lib) => parseLibraryName(lib.name));

  const alreadyInManifest = parsed.some((p) => p.group === "org.lwjgl" && p.artifact === "lwjgl" && p.classifier === classifier);
  if (alreadyInManifest) return; // manifest covers it - downloadVanillaLibraries already fetched it

  const sibling = parsed.find(
    (p) => p.group === "org.lwjgl" && p.artifact && p.artifact !== "lwjgl" && p.artifact.startsWith("lwjgl")
  );
  if (!sibling) return; // this version doesn't use LWJGL at all

  const version = sibling.version;
  const jarName = `lwjgl-${version}-${classifier}.jar`;
  const mavenPath = `org/lwjgl/lwjgl/${version}/${jarName}`;
  const url = `https://repo1.maven.org/maven2/${mavenPath}`;

  onProgress && onProgress(1, 1, `org.lwjgl:lwjgl:${version}:${classifier} (fetched manually - absent from manifest)`);
  await downloadToFile(url, path.join(librariesDir, mavenPath), null);
}

/** Downloads native (platform-specific) libraries and extracts them into <versionDir>/natives. */
async function downloadNatives(libraries, versionDir, onProgress) {
  const platform = currentOsName();
  const nativesDir = path.join(versionDir, "natives");
  await fsp.mkdir(nativesDir, { recursive: true });

  const withNatives = librariesForCurrentOS(libraries).filter(
    (l) => l.natives && l.natives[platform] && l.downloads && l.downloads.classifiers
  );

  for (let i = 0; i < withNatives.length; i++) {
    const lib = withNatives[i];
    onProgress && onProgress(i + 1, withNatives.length, lib.name);
    const classifierKey = lib.natives[platform];
    const classifier = lib.downloads.classifiers[classifierKey];
    if (!classifier) continue;

    const tmpJar = path.join(versionDir, ".tmp-natives", `${i}.jar`);
    await downloadToFile(classifier.url, tmpJar, classifier.sha1);
    try {
      await extract(tmpJar, { dir: nativesDir });
    } catch {
      /* some native jars include odd entries; best-effort extraction is fine here */
    }
  }

  const tmpDir = path.join(versionDir, ".tmp-natives");
  if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true, force: true });
}

/** Downloads the asset index + referenced objects into <versionDir>/assets. */
async function downloadAssets(assetIndexMeta, versionDir, onProgress) {
  const assetIndexRes = await fetch(assetIndexMeta.url);
  const assetIndex = await assetIndexRes.json();

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
    await downloadToFile(url, path.join(assetsDir, "objects", sub, obj.hash), obj.hash);
  }

  return assetIndex;
}

/** Downloads a Fabric/Quilt loader library (maven coordinate + repo url) into <versionDir>/libraries. */
async function downloadLoaderLibraries(loaderLibraries, librariesDir, onProgress) {
  for (let i = 0; i < loaderLibraries.length; i++) {
    const lib = loaderLibraries[i];
    onProgress && onProgress(i + 1, loaderLibraries.length, lib.name);
    await downloadToFile(lib.url, path.join(librariesDir, lib.path));
  }
}

/**
 * @param {string} versionId        vanilla Minecraft version, e.g. "1.21.1"
 * @param {string} destDir          folder this version should live in (already includes the display name)
 * @param {"vanilla"|"fabric"|"quilt"} loaderKind
 * @param {string|null} loaderVersion  specific loader build, or null for "latest stable"
 * @param {{profile:object,minecraftAccessToken:string,ownsGame:boolean}|null} session  active Microsoft session, if any
 * @param {(info:object)=>void} onProgress
 */
async function installVersion(versionId, destDir, loaderKind, loaderVersion, session, onProgress) {
  const notify = (stage, extra = {}) => onProgress && onProgress({ stage, ...extra });

  notify("manifest");
  const manifest = await getVersionManifest();
  const meta = manifest.versions.find((v) => v.id === versionId);
  if (!meta) throw new Error(`Unknown version "${versionId}".`);

  notify("version_details");
  const details = await getVersionDetails(meta);

  await fsp.mkdir(destDir, { recursive: true });
  await fsp.writeFile(path.join(destDir, "version.json"), JSON.stringify(details, null, 2));

  notify("client_jar");
  const clientDl = details.downloads.client;
  await downloadToFile(clientDl.url, path.join(destDir, "client.jar"), clientDl.sha1);

  const librariesDir = path.join(destDir, "libraries");
  notify("libraries");
  await downloadVanillaLibraries(details.libraries, librariesDir, (current, total, label) =>
    notify("libraries", { current, total, label })
  );

  notify("lwjgl_arm64_check");
  await ensureLwjglCoreArm64Native(
    details.libraries,
    librariesDir,
    currentOsName(),
    currentArchName(),
    (current, total, label) => notify("lwjgl_arm64_check", { current, total, label })
  );

  notify("natives");
  await downloadNatives(details.libraries, destDir, (current, total, label) =>
    notify("natives", { current, total, label })
  );

  notify("asset_index");
  await downloadAssets(details.assetIndex, destDir, (current, total, label) =>
    notify("assets", { current, total, label })
  );

  let mainClass = details.mainClass;
  let resolvedLoaderVersion = null;

  if (loaderKind === "fabric" || loaderKind === "quilt") {
    notify("loader_resolve", { label: loaderKind });
    const loader = await resolveLoader(loaderKind, versionId, loaderVersion);
    resolvedLoaderVersion = loader.loaderVersion;
    mainClass = loader.mainClass;

    notify("loader_libraries", { label: loaderKind });
    await downloadLoaderLibraries(loader.libraries, librariesDir, (current, total, label) =>
      notify("loader_libraries", { current, total, label })
    );
  }

  notify("writing_start_script");
  const credentials =
    session && session.ownsGame && session.profile
      ? { mode: "msa", uuid: session.profile.id, accessToken: session.minecraftAccessToken }
      : { mode: "offline" };

  const startPy = buildStartPy({
    mainClass,
    versionId,
    assetIndexId: details.assetIndex.id,
    versionType: details.type || "release",
    credentials,
  });
  await fsp.writeFile(path.join(destDir, "start.py"), startPy, "utf-8");

  notify("done");
  return {
    path: destDir,
    mainClass,
    assetIndexId: details.assetIndex.id,
    versionId,
    loader: loaderKind,
    loaderVersion: resolvedLoaderVersion,
    credentialMode: credentials.mode,
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
};
