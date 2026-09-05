"use strict";

const { fetchJson, fetchUA } = require("./http");

const SEARCH = "https://api.modrinth.com/v2/search";
const PROJECT = "https://api.modrinth.com/v2/project";

function loaderFacets(family) {
  if (!family || family === "all") return [];
  if (family === "forge") return [["categories:forge", "categories:neoforge"]];
  return [[`categories:${family}`]];
}

async function searchMods({ query = "", family = "fabric", limit = 50, offset = 0, index = "downloads" } = {}) {
  const facets = [["project_type:mod"], ...loaderFacets(family)];
  const params = new URLSearchParams({
    query,
    limit: String(limit),
    offset: String(offset),
    index,
    facets: JSON.stringify(facets),
  });
  return fetchJson(`${SEARCH}?${params.toString()}`);
}

async function trendingMods(family = "fabric") {
  return searchMods({ query: "", family, limit: 50, index: "downloads" });
}

async function projectVersions(projectId, { gameVersion, loaders } = {}) {
  const params = new URLSearchParams();
  if (gameVersion) params.set("game_versions", JSON.stringify([gameVersion]));
  if (loaders && loaders.length) params.set("loaders", JSON.stringify(loaders));
  const qs = params.toString();
  const url = `${PROJECT}/${encodeURIComponent(projectId)}/version${qs ? `?${qs}` : ""}`;
  return fetchJson(url);
}

async function downloadModFile(url, destPath) {
  const fs = require("fs");
  const fsp = fs.promises;
  const path = require("path");
  await fsp.mkdir(path.dirname(destPath), { recursive: true });
  const res = await fetchUA(url);
  if (!res.ok) throw new Error(`Mod download failed (${res.status})`);
  await new Promise((resolve, reject) => {
    const out = fs.createWriteStream(destPath);
    res.body.pipe(out);
    res.body.on("error", reject);
    out.on("finish", resolve);
    out.on("error", reject);
  });
  return destPath;
}

function familyLoaders(family) {
  if (family === "forge") return ["forge", "neoforge"];
  if (family === "neoforge") return ["neoforge"];
  if (family === "quilt") return ["quilt"];
  if (family === "fabric") return ["fabric"];
  return ["fabric", "quilt", "forge", "neoforge"];
}

module.exports = { searchMods, trendingMods, projectVersions, downloadModFile, familyLoaders };
