"use strict";

/**
 * Talks to the public, unauthenticated meta APIs that Fabric and Quilt
 * publish for their installers/launchers. No login required to read
 * these - only the Microsoft sign-in (msAuth.js) is about identity, not
 * about unlocking loader downloads.
 */

const fetch = require("node-fetch");

const FABRIC_META = "https://meta.fabricmc.net/v2";
const QUILT_META = "https://meta.quiltmc.org/v3";

async function getJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Request failed (${res.status}): ${url}`);
  return res.json();
}

/** Loader versions available for a given Minecraft version, newest first. */
async function listFabricLoaderVersions(mcVersion) {
  const rows = await getJson(`${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
  return rows.map((r) => ({ version: r.loader.version, stable: !!r.loader.stable }));
}

async function listQuiltLoaderVersions(mcVersion) {
  const rows = await getJson(`${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}`);
  return rows.map((r) => ({ version: r.loader.version, stable: !!r.loader.stable }));
}

/** Full launch profile (mainClass + libraries) for a specific loader build. */
async function getFabricProfile(mcVersion, loaderVersion) {
  return getJson(
    `${FABRIC_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );
}

async function getQuiltProfile(mcVersion, loaderVersion) {
  return getJson(
    `${QUILT_META}/versions/loader/${encodeURIComponent(mcVersion)}/${encodeURIComponent(loaderVersion)}/profile/json`
  );
}

/**
 * Picks the newest stable loader build for a Minecraft version, falling
 * back to the newest build at all if nothing is marked stable.
 */
async function pickLatestLoaderVersion(kind, mcVersion) {
  const list = kind === "fabric" ? await listFabricLoaderVersions(mcVersion) : await listQuiltLoaderVersions(mcVersion);
  if (!list.length) throw new Error(`No ${kind} loader builds published for Minecraft ${mcVersion}.`);
  return (list.find((v) => v.stable) || list[0]).version;
}

/**
 * Converts a Maven coordinate ("group:artifact:version[:classifier]") into
 * a relative file path, the way Maven repositories lay them out.
 */
function mavenCoordToPath(coord) {
  const parts = coord.split(":");
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  const groupPath = group.replace(/\./g, "/");
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return `${groupPath}/${artifact}/${version}/${fileName}`;
}

/**
 * Normalizes a loader profile's "libraries" array (which may be a flat
 * list or split into client/common/server buckets depending on API
 * version) into a flat list of { url, path } download descriptors.
 */
function flattenLoaderLibraries(profile) {
  const buckets = Array.isArray(profile.libraries)
    ? profile.libraries
    : [
        ...(profile.libraries?.client || []),
        ...(profile.libraries?.common || []),
      ];

  return buckets
    .filter((lib) => lib && lib.name)
    .map((lib) => {
      const base = (lib.url || "https://maven.fabricmc.net/").replace(/\/?$/, "/");
      const relPath = mavenCoordToPath(lib.name);
      return { url: base + relPath, path: relPath, name: lib.name };
    });
}

/**
 * Resolves everything needed to install a loader on top of a vanilla
 * version: the chosen loader version, its main class, and its extra
 * libraries (on top of vanilla's own libraries).
 */
async function resolveLoader(kind, mcVersion, requestedLoaderVersion) {
  if (kind !== "fabric" && kind !== "quilt") {
    throw new Error(`Unsupported loader "${kind}". Supported: vanilla, fabric, quilt.`);
  }

  const loaderVersion = requestedLoaderVersion || (await pickLatestLoaderVersion(kind, mcVersion));
  const profile = kind === "fabric" ? await getFabricProfile(mcVersion, loaderVersion) : await getQuiltProfile(mcVersion, loaderVersion);

  return {
    kind,
    loaderVersion,
    mainClass: profile.mainClass,
    libraries: flattenLoaderLibraries(profile),
  };
}

module.exports = {
  listFabricLoaderVersions,
  listQuiltLoaderVersions,
  resolveLoader,
  mavenCoordToPath,
};
