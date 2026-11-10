"use strict";

/**
 * Per-profile resource packs: listing, drag-and-drop import, deleting, and
 * installing packs straight from the Modrinth marketplace.
 */

const fs = require("fs");
const path = require("path");
const modrinth = require("./modrinth");
const { readPackMeta } = require("./jarMeta");

function resourcePacksDir(profilePath) {
  return path.join(profilePath, "resourcepacks");
}

function ensureDir(profilePath) {
  const dir = resourcePacksDir(profilePath);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function listResourcePacks(profilePath) {
  const dir = ensureDir(profilePath);
  const packs = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      let description = "";
      let format = null;
      const mcmeta = path.join(full, "pack.mcmeta");
      if (fs.existsSync(mcmeta)) {
        try {
          const data = JSON.parse(fs.readFileSync(mcmeta, "utf-8"));
          const pack = data.pack || {};
          description = typeof pack.description === "string" ? pack.description : "";
          format = Array.isArray(pack.pack_format) ? pack.pack_format[0] : pack.pack_format;
        } catch {
          /* ignore malformed mcmeta */
        }
      }
      packs.push({ name: entry.name, kind: "folder", description, format, size: null });
    } else if (/\.zip$/i.test(entry.name)) {
      const meta = readPackMeta(full) || {};
      let size = 0;
      try {
        size = fs.statSync(full).size;
      } catch {
        /* ignore */
      }
      packs.push({
        name: entry.name,
        kind: "zip",
        description: meta.description || "",
        format: meta.format ?? null,
        size,
      });
    }
  }
  packs.sort((a, b) => a.name.localeCompare(b.name));
  return packs;
}

function uniqueName(dir, name) {
  let dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return dest;
}

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(from, to);
    else fs.copyFileSync(from, to);
  }
}

/**
 * Imports dropped/selected files or folders into <profile>/resourcepacks.
 * Returns the packs that were added.
 */
function importResourcePacks(profilePath, sourcePaths) {
  const dir = ensureDir(profilePath);
  const added = [];
  for (const src of sourcePaths || []) {
    if (!src || !fs.existsSync(src)) continue;
    const stat = fs.statSync(src);
    const base = path.basename(src);
    if (stat.isDirectory()) {
      const dest = uniqueName(dir, base);
      copyDirRecursive(src, dest);
      added.push(path.basename(dest));
    } else if (/\.zip$/i.test(base)) {
      const dest = uniqueName(dir, base);
      fs.copyFileSync(src, dest);
      added.push(path.basename(dest));
    }
  }
  if (!added.length) {
    throw new Error("Nothing to import — drop a resource pack .zip or a pack folder.");
  }
  return { added, packs: listResourcePacks(profilePath) };
}

function deleteResourcePack(profilePath, name) {
  const safe = path.basename(String(name || ""));
  if (!safe || safe !== name) throw new Error("Invalid resource pack name.");
  const dir = resourcePacksDir(profilePath);
  const target = path.join(dir, safe);
  if (!target.startsWith(dir)) throw new Error("Refusing to delete outside the resourcepacks folder.");
  if (!fs.existsSync(target)) throw new Error(`"${safe}" is not installed.`);
  fs.rmSync(target, { recursive: true, force: true });
  return { removed: safe, packs: listResourcePacks(profilePath) };
}

/** Installs a resource pack from the Modrinth marketplace into the profile. */
async function installFromModrinth(profilePath, projectId, versionId) {
  const version = versionId ? await modrinth.getVersion(versionId) : null;
  const versions = version ? [version] : await modrinth.getVersions(projectId);
  const chosen = versions[0];
  if (!chosen) throw new Error("No downloadable version of that resource pack was found.");
  const file = modrinth.primaryFile(chosen);
  if (!file || !file.url) throw new Error("That resource pack has no downloadable file.");

  const dir = ensureDir(profilePath);
  const dest = uniqueName(dir, path.basename(file.filename));
  await modrinth.downloadToFile(file.url, dest);
  return { filename: path.basename(dest), packs: listResourcePacks(profilePath) };
}

module.exports = {
  resourcePacksDir,
  ensureDir,
  listResourcePacks,
  importResourcePacks,
  deleteResourcePack,
  installFromModrinth,
};
