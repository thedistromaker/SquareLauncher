"use strict";

/**
 * Public loader metadata:
 *   Fabric  https://meta.fabricmc.net/v2
 *   Quilt   https://meta.quiltmc.org/v3
 *   Forge   https://maven.minecraftforge.net/.../maven-metadata.xml
 *   NeoForge https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml
 */

const { fetchJson, fetchText } = require("./http");
const { mavenCoordToPath } = require("./launchProfile");
const cache = require("./cacheManager");

const FABRIC_META = "https://meta.fabricmc.net/v2";
const QUILT_META = "https://meta.quiltmc.org/v3";
const FORGE_META = "https://maven.minecraftforge.net/net/minecraftforge/forge/maven-metadata.xml";
const NEOFORGE_META = "https://maven.neoforged.net/releases/net/neoforged/neoforge/maven-metadata.xml";

async function getJson(url) {
  return fetchJson(url);
}

function parseMavenVersions(xml) {
  const versions = [];
  const re = /<version>([^<]+)<\/version>/g;
  let m;
  while ((m = re.exec(xml))) versions.push(m[1]);
  return versions;
}

async function listFabricLoaderVersions(mcVersion) {
  const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`;
  const rows = await cache.cachedLoaderJson(`fabric_versions_${mcVersion}`, url);
  return rows.map((r) => ({ version: r.loader.version, stable: !!r.loader.stable }));
}

async function listQuiltLoaderVersions(mcVersion) {
  const url = `${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`;
  const rows = await cache.cachedLoaderJson(`quilt_versions_${mcVersion}`, url);
  return rows.map((r) => ({ version: r.loader.version, stable: !!r.loader.stable }));
}

async function getFabricProfile(mcVersion, loaderVersion) {
  const url = `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  return cache.cachedLoaderJson(`fabric_profile_${mcVersion}_${loaderVersion}`, url);
}

async function getQuiltProfile(mcVersion, loaderVersion) {
  const url = `${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`;
  return cache.cachedLoaderJson(`quilt_profile_${mcVersion}_${loaderVersion}`, url);
}

async function pickLatestLoaderVersion(kind, mcVersion) {
  const list = kind === "fabric" ? await listFabricLoaderVersions(mcVersion) : await listQuiltLoaderVersions(mcVersion);
  if (!list.length) throw new Error(`No ${kind} loader builds published for Minecraft ${mcVersion}.`);
  return (list.find((v) => v.stable) || list[0]).version;
}

function flattenLoaderLibraries(profile) {
  const buckets = Array.isArray(profile.libraries)
    ? profile.libraries
    : [...(profile.libraries?.client || []), ...(profile.libraries?.common || [])];

  return buckets
    .filter((lib) => lib && lib.name)
    .map((lib) => {
      const base = (lib.url || "https://maven.fabricmc.net/").replace(/\/?$/, "/");
      const relPath = mavenCoordToPath(lib.name);
      return { url: base + relPath, path: relPath, name: lib.name };
    });
}

async function resolveLoader(kind, mcVersion, requestedLoaderVersion) {
  if (kind !== "fabric" && kind !== "quilt") {
    throw new Error(`Unsupported yarn-style loader "${kind}".`);
  }
  const loaderVersion = requestedLoaderVersion || (await pickLatestLoaderVersion(kind, mcVersion));
  const profile = kind === "fabric" ? await getFabricProfile(mcVersion, loaderVersion) : await getQuiltProfile(mcVersion, loaderVersion);
  return {
    kind,
    loaderVersion,
    mainClass: profile.mainClass,
    libraries: flattenLoaderLibraries(profile),
    profile,
  };
}

async function listForgeVersions(mcVersion) {
  const xml = await cache.cachedLoaderText("forge_maven_metadata", FORGE_META);
  const prefix = `${mcVersion}-`;
  return parseMavenVersions(xml)
    .filter((v) => v.startsWith(prefix))
    .reverse();
}

function neoForgePrefix(mcVersion) {
  // "1.21.1" -> "21.1" ; "1.21" -> "21.0"
  const parts = String(mcVersion).split(".");
  if (parts.length < 2) return null;
  const minor = parts[1];
  const patch = parts[2] || "0";
  return `${minor}.${patch}`;
}

async function listNeoForgeVersions(mcVersion) {
  const xml = await cache.cachedLoaderText("neoforge_maven_metadata", NEOFORGE_META);
  const prefix = neoForgePrefix(mcVersion);
  if (!prefix) return [];
  return parseMavenVersions(xml)
    .filter((v) => v.startsWith(prefix + ".") || v === prefix)
    .reverse();
}

function forgeInstallerUrl(forgeVersion) {
  return `https://maven.minecraftforge.net/net/minecraftforge/forge/${forgeVersion}/forge-${forgeVersion}-installer.jar`;
}

function neoForgeInstallerUrl(neoVersion) {
  return `https://maven.neoforged.net/releases/net/neoforged/neoforge/${neoVersion}/neoforge-${neoVersion}-installer.jar`;
}

module.exports = {
  listFabricLoaderVersions,
  listQuiltLoaderVersions,
  listForgeVersions,
  listNeoForgeVersions,
  resolveLoader,
  getFabricProfile,
  getQuiltProfile,
  mavenCoordToPath,
  forgeInstallerUrl,
  neoForgeInstallerUrl,
  flattenLoaderLibraries,
};
