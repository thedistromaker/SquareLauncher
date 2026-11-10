"use strict";

/**
 * Modrinth API v2 client used by the mod and resource-pack marketplace.
 *
 * Facets (all AND-ed groups, OR inside a group):
 *   project_type:mod | resourcepack | shader
 *   categories:<loader|category>
 *   versions:<game version>
 *   client_side / server_side: required | optional | unsupported
 *   open_source:true
 */

const fs = require("fs");
const path = require("path");
const { fetchJson, fetchUA } = require("./http");

const API = "https://api.modrinth.com/v2";
const SEARCH = `${API}/search`;
const PROJECT = `${API}/project`;
const VERSION = `${API}/version`;

const LOADER_FAMILIES = {
  fabric: ["fabric"],
  quilt: ["quilt"],
  forge: ["forge"],
  neoforge: ["neoforge"],
  all: ["fabric", "quilt", "forge", "neoforge"],
};

function familyLoaders(family) {
  return LOADER_FAMILIES[family] || LOADER_FAMILIES.all;
}

/** Builds the Modrinth `facets` matrix from the UI filter state. */
function buildFacets(filters = {}) {
  const groups = [];
  const projectType = filters.projectType || "mod";
  groups.push([`project_type:${projectType}`]);

  const loaders = filters.loaders && filters.loaders.length ? filters.loaders : null;
  if (loaders && projectType === "mod") groups.push(loaders.map((l) => `categories:${l}`));

  if (filters.gameVersions && filters.gameVersions.length) {
    groups.push(filters.gameVersions.map((v) => `versions:${v}`));
  }
  if (filters.categories && filters.categories.length) {
    groups.push(filters.categories.map((c) => `categories:${c}`));
  }
  if (filters.environment === "client") {
    groups.push(["client_side:required", "client_side:optional"]);
  } else if (filters.environment === "server") {
    groups.push(["server_side:required", "server_side:optional"]);
  }
  if (filters.openSource) groups.push(["open_source:true"]);
  if (filters.licenses && filters.licenses.length) {
    groups.push(filters.licenses.map((licence) => `license:${licence}`));
  }
  return groups;
}

async function searchProjects(filters = {}) {
  const limit = Math.min(Number(filters.limit) || 40, 100);
  const params = new URLSearchParams({
    query: filters.query || "",
    limit: String(limit),
    offset: String(Number(filters.offset) || 0),
    index: filters.index || (filters.query ? "relevance" : "downloads"),
  });
  const facets = filters.facets || buildFacets(filters);
  if (facets.length) params.set("facets", JSON.stringify(facets));
  return fetchJson(`${SEARCH}?${params.toString()}`);
}

async function trending({ family = "fabric", projectType = "mod", limit = 40 } = {}) {
  return searchProjects({
    query: "",
    projectType,
    loaders: projectType === "mod" ? familyLoaders(family) : [],
    limit,
    index: "downloads",
  });
}

async function getProject(idOrSlug) {
  return fetchJson(`${PROJECT}/${encodeURIComponent(idOrSlug)}`);
}

async function getProjects(ids) {
  const list = Array.from(new Set((ids || []).filter(Boolean)));
  if (!list.length) return [];
  const params = new URLSearchParams({ ids: JSON.stringify(list) });
  return fetchJson(`${PROJECT}?${params.toString()}`);
}

async function getVersions(projectId, { gameVersion, loaders, featured } = {}) {
  const params = new URLSearchParams();
  if (gameVersion) params.set("game_versions", JSON.stringify([gameVersion]));
  if (loaders && loaders.length) params.set("loaders", JSON.stringify(loaders));
  if (featured) params.set("featured", "true");
  const qs = params.toString();
  // Modrinth v2 uses the singular "version" endpoint.
  return fetchJson(`${PROJECT}/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ""}`);
}

async function getVersion(versionId) {
  return fetchJson(`${VERSION}/${encodeURIComponent(versionId)}`);
}

function primaryFile(version) {
  const files = version && version.files ? version.files : [];
  return files.find((f) => f.primary) || files[0] || null;
}

/**
 * Picks the newest compatible version for a dependency and returns a task
 * descriptor without downloading anything.
 */
async function pickDependencyVersion(dep, { gameVersion, loaders } = {}) {
  if (!dep || dep.dependency_type !== "required") return null;
  if (!dep.project_id) {
    return {
      resolved: false,
      projectId: null,
      projectName: dep.file_name || null,
      reason: dep.file_name
        ? `Required file "${dep.file_name}" is not published as a Modrinth project.`
        : "This version declares an external dependency that cannot be resolved automatically.",
    };
  }
  let project = null;
  try {
    project = await getProject(dep.project_id);
  } catch {
    /* fall through to the unresolved case */
  }
  let versions = [];
  try {
    versions = await getVersions(dep.project_id, {
      gameVersion,
      loaders: loaders && loaders.length ? loaders : undefined,
    });
  } catch {
    versions = [];
  }
  const version = versions[0] || null;
  if (!version) {
    return {
      resolved: false,
      projectId: dep.project_id,
      projectName: project ? project.title : dep.project_id,
      reason: "No compatible version of this dependency exists for the profile's game version/loader.",
    };
  }
  const file = primaryFile(version);
  if (!file) {
    return {
      resolved: false,
      projectId: dep.project_id,
      projectName: project ? project.title : dep.project_id,
      reason: "The dependency has no downloadable file.",
    };
  }
  return {
    resolved: true,
    projectId: dep.project_id,
    projectName: project ? project.title : dep.project_id,
    projectSlug: project ? project.slug : null,
    projectIcon: project ? project.icon_url : null,
    versionId: version.id,
    versionNumber: version.version_number || version.id,
    filename: file.filename,
    url: file.url,
    hashes: file.hashes || {},
    dependencies: version.dependencies || [],
    optional: dep.dependency_type === "optional",
  };
}

/** All dependency descriptors of a version, resolved or not. */
async function resolveVersionDependencies(version, options = {}) {
  const deps = Array.isArray(version && version.dependencies) ? version.dependencies : [];
  const out = [];
  for (const dep of deps) {
    if (dep.dependency_type === "incompatible") {
      out.push({
        resolved: false,
        incompatible: true,
        projectId: dep.project_id || null,
        projectName: dep.file_name || dep.project_id || null,
        reason: "This version is marked incompatible with that project.",
      });
      continue;
    }
    if (dep.dependency_type === "embedded") continue;
    if (dep.dependency_type === "optional") continue;
    out.push(await pickDependencyVersion(dep, options));
  }
  return out;
}

async function downloadToFile(url, destPath) {
  await fs.promises.mkdir(path.dirname(destPath), { recursive: true });
  const tmp = `${destPath}.part-${process.pid}`;
  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Download failed (${res.status})`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(tmp);
    res.body.on("error", reject);
    res.body.pipe(out);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  fs.renameSync(tmp, destPath);
  return destPath;
}

module.exports = {
  LOADER_FAMILIES,
  buildFacets,
  familyLoaders,
  searchProjects,
  trending,
  getProject,
  getProjects,
  getVersions,
  getVersion,
  primaryFile,
  resolveVersionDependencies,
  pickDependencyVersion,
  downloadToFile,
};
