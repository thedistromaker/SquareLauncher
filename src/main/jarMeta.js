"use strict";

/**
 * Reads mod metadata straight out of a JAR's central directory.
 *
 * We only need a handful of small text entries (fabric.mod.json, mods.toml,
 * pack.mcmeta, MANIFEST.MF), so pulling in a full zip library would be
 * overkill. This parses the zip central directory by hand and inflates just
 * the entries we ask for. That gives us a real mod id + declared dependencies
 * for duplicate detection and the dependency tree, instead of guessing from
 * filenames.
 */

const fs = require("fs");
const zlib = require("zlib");

const EOCD_SIG = 0x06054b50;
const CENTRAL_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;

function findEndOfCentralDirectory(buffer) {
  const min = 22;
  const start = Math.max(0, buffer.length - 65558);
  for (let i = buffer.length - min; i >= start; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      const centralOffset = buffer.readUInt32LE(i + 16);
      const totalEntries = buffer.readUInt16LE(i + 10);
      if (centralOffset < buffer.length) return { centralOffset, totalEntries };
    }
  }
  return null;
}

function readCentralDirectory(buffer) {
  const eocd = findEndOfCentralDirectory(buffer);
  if (!eocd) return [];
  const entries = [];
  let offset = eocd.centralOffset;
  for (let i = 0; i < eocd.totalEntries; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== CENTRAL_SIG) break;
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString("utf8", offset + 46, offset + 46 + nameLen);
    entries.push({ name, method, compressedSize, size, localOffset });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

function readEntry(buffer, entry) {
  if (!entry || entry.localOffset + 30 > buffer.length) return null;
  if (buffer.readUInt32LE(entry.localOffset) !== LOCAL_SIG) return null;
  const nameLen = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLen = buffer.readUInt16LE(entry.localOffset + 28);
  const dataStart = entry.localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + entry.compressedSize;
  if (dataEnd > buffer.length) return null;
  const raw = buffer.subarray(dataStart, dataEnd);
  try {
    if (entry.method === 0) return raw;
    if (entry.method === 8) return zlib.inflateRawSync(raw);
  } catch {
    return null;
  }
  return null;
}

function readEntriesFromBuffer(buffer, wantedNames) {
  const entries = readCentralDirectory(buffer);
  const wanted = new Set(wantedNames);
  const out = {};
  for (const entry of entries) {
    if (!wanted.has(entry.name)) continue;
    const data = readEntry(buffer, entry);
    if (data) out[entry.name] = data.toString("utf8");
  }
  return out;
}

function readZipEntries(filePath, wantedNames) {
  return readEntriesFromBuffer(fs.readFileSync(filePath), wantedNames);
}

function stripTomlComment(line) {
  let inString = false;
  for (let i = 0; i < line.length; i++) {
    if (line[i] === '"' && line[i - 1] !== "\\") inString = !inString;
    if (line[i] === "#" && !inString) return line.slice(0, i);
  }
  return line;
}

function tomlValue(line) {
  const eq = line.indexOf("=");
  if (eq === -1) return null;
  return line
    .slice(eq + 1)
    .trim()
    .replace(/,$/, "")
    .replace(/^"|"$/g, "")
    .replace(/^'|'$/g, "");
}

/** Very small TOML reader: enough for mods.toml / neoforge.mods.toml. */
function parseModsToml(text) {
  const lines = text.split(/\r?\n/).map(stripTomlComment);
  let inModList = false;
  let inDependencies = false;
  let dependencyOwner = null;
  const mods = [];
  const dependencies = [];
  let current = null;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;

    if (line.startsWith("[[mods]]")) {
      inModList = true;
      inDependencies = false;
      current = {};
      mods.push(current);
      continue;
    }
    if (line.startsWith("[[dependencies.")) {
      inModList = false;
      inDependencies = true;
      const match = line.match(/\[\[dependencies\.([^\]]+)\]\]/);
      dependencyOwner = match ? match[1] : null;
      current = { owner: dependencyOwner };
      dependencies.push(current);
      continue;
    }
    if (line.startsWith("[[") || line.startsWith("[") && !line.startsWith("[[")) {
      inModList = false;
      inDependencies = false;
      current = null;
      continue;
    }

    const value = tomlValue(line);
    if (value === null) continue;
    const key = line.slice(0, line.indexOf("=")).trim();

    if (inModList && current) {
      if (key === "modId") current.modId = value;
      else if (key === "displayName") current.displayName = value;
      else if (key === "version") current.version = value;
    } else if (inDependencies && current) {
      if (key === "modId") current.modId = value;
      else if (key === "mandatory") current.mandatory = value === "true";
      else if (key === "versionRange") current.versionRange = value;
      else if (key === "type") current.type = value;
    }
  }

  const primary = mods[0] || {};
  return {
    id: primary.modId || null,
    name: primary.displayName || primary.modId || null,
    version: primary.version || null,
    dependencies: dependencies
      .filter((d) => d.modId && d.modId !== "minecraft" && d.modId !== "forge" && d.modId !== "neoforge")
      .map((d) => ({
        id: d.modId,
        mandatory: d.mandatory !== false,
        versionRange: d.versionRange || null,
      })),
  };
}

function parseFabricMeta(text) {
  const data = JSON.parse(text);
  const depends = data.depends && typeof data.depends === "object" ? data.depends : {};
  return {
    id: data.id || null,
    name: data.name || data.id || null,
    version: data.version || null,
    dependencies: Object.entries(depends)
      .filter(([id]) => !["minecraft", "java", "fabricloader", "fabric-loader"].includes(id))
      .map(([id, range]) => ({
        id,
        mandatory: true,
        versionRange: typeof range === "string" ? range : null,
      })),
    nestedJars: Array.isArray(data.jars)
      ? data.jars
          .map((entry) => (typeof entry === "string" ? entry : entry && entry.file))
          .filter(Boolean)
      : [],
  };
}

function parseQuiltMeta(text) {
  const data = JSON.parse(text);
  const loader = data.quilt_loader || {};
  const meta = loader.metadata || {};
  const deps = Array.isArray(loader.depends) ? loader.depends : [];
  return {
    id: loader.id || null,
    name: meta.name || loader.id || null,
    version: loader.version || null,
    dependencies: deps
      .filter((d) => d && d.id && !["minecraft", "java", "quilt_loader"].includes(d.id))
      .map((d) => ({
        id: d.id,
        mandatory: !d.optional,
        versionRange: d.versions || null,
      })),
    nestedJars: Array.isArray(data.jars)
      ? data.jars
          .map((entry) => (typeof entry === "string" ? entry : entry && entry.file))
          .filter(Boolean)
      : [],
  };
}

const MOD_META_FILES = [
  "fabric.mod.json",
  "quilt.mod.json",
  "META-INF/neoforge.mods.toml",
  "META-INF/mods.toml",
];

/**
 * Reads metadata from an in-memory jar. Fabric/Quilt jars can nest other mods
 * under META-INF/jars (Fabric's "jar-in-jar"); those nested mods satisfy
 * dependencies too, so record them in `provides` instead of reporting a false
 * missing dependency. Forge/NeoForge jars have no manifest list, so scan their
 * nested-jar folder once at the top level.
 */
function readModMetaFromBuffer(buffer, depth = 0, seen = new Set()) {
  let entries;
  try {
    entries = readCentralDirectory(buffer);
  } catch {
    return null;
  }

  const texts = readEntriesFromBuffer(buffer, MOD_META_FILES);
  let meta;
  try {
    if (texts["fabric.mod.json"]) {
      meta = { loader: "fabric", ...parseFabricMeta(texts["fabric.mod.json"]) };
    } else if (texts["quilt.mod.json"]) {
      meta = { loader: "quilt", ...parseQuiltMeta(texts["quilt.mod.json"]) };
    } else if (texts["META-INF/neoforge.mods.toml"]) {
      meta = { loader: "neoforge", ...parseModsToml(texts["META-INF/neoforge.mods.toml"]) };
    } else if (texts["META-INF/mods.toml"]) {
      meta = { loader: "forge", ...parseModsToml(texts["META-INF/mods.toml"]) };
    }
  } catch {
    return null;
  }
  if (!meta || !meta.id) return null;

  const nestedFiles = new Set(meta.nestedJars || []);
  if (depth === 0 && nestedFiles.size === 0) {
    for (const entry of entries) {
      if (/^META-INF\/jars\/[^/]+\.jar$/i.test(entry.name)) nestedFiles.add(entry.name);
    }
  }

  const embedded = [];
  if (depth < 2) {
    for (const file of [...nestedFiles].slice(0, 32)) {
      if (!file || seen.has(file)) continue;
      seen.add(file);
      const nestedEntry = entries.find((entry) => entry.name === file);
      if (!nestedEntry) continue;
      const data = readEntry(buffer, nestedEntry);
      if (!data) continue;
      const child = readModMetaFromBuffer(data, depth + 1, seen);
      if (!child || !child.id) continue;
      embedded.push({
        id: child.id,
        name: child.name,
        version: child.version,
        loader: child.loader,
        filename: file.split("/").pop(),
      });
    }
  }

  return {
    ...meta,
    provides: [...new Set([meta.id, ...embedded.map((entry) => entry.id)].filter(Boolean))],
    embedded,
  };
}

/** Reads mod metadata from a jar path. Returns null for non-mod jars. */
function readModMeta(jarPath) {
  try {
    return readModMetaFromBuffer(fs.readFileSync(jarPath));
  } catch {
    return null;
  }
}

/** pack.mcmeta inside a resource pack zip, for the packs list. */
function readPackMeta(zipPath) {
  try {
    const entries = readZipEntries(zipPath, ["pack.mcmeta"]);
    if (!entries["pack.mcmeta"]) return null;
    const data = JSON.parse(entries["pack.mcmeta"]);
    const pack = data.pack || {};
    const description =
      typeof pack.description === "string"
        ? pack.description
        : pack.description && typeof pack.description === "object"
          ? JSON.stringify(pack.description)
          : "";
    const format = Array.isArray(pack.pack_format) ? pack.pack_format[0] : pack.pack_format;
    return { description, format: format ?? null };
  } catch {
    return null;
  }
}

module.exports = { readModMeta, readPackMeta, readZipEntries };
