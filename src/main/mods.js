"use strict";

/**
 * Installed-mod management for one profile.
 *
 * Responsibilities:
 *  - read every jar in <profile>/mods and pull its real mod id from its own
 *    metadata (fabric.mod.json / mods.toml), not from the filename;
 *  - refuse to install a second copy of an already-installed mod: an update
 *    replaces the old jar instead of stacking two versions side by side;
 *  - resolve and install Modrinth "required" dependencies, recursively;
 *  - build the dependency tree rendered in the profile settings modal.
 */

const fs = require("fs");
const path = require("path");
const modrinth = require("./modrinth");
const jarMeta = require("./jarMeta");

const META_DIR = ".cuboid";
const MAX_DEP_DEPTH = 5;

function modsDir(profilePath) {
  return path.join(profilePath, "mods");
}

function manifestPath(profilePath) {
  return path.join(profilePath, META_DIR, "mods.json");
}

function readManifest(profilePath) {
  const file = manifestPath(profilePath);
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf-8"));
    return { projects: data.projects && typeof data.projects === "object" ? data.projects : {} };
  } catch {
    return { projects: {} };
  }
}

function writeManifest(profilePath, manifest) {
  const file = manifestPath(profilePath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
}

function manifestByModId(manifest) {
  const map = new Map();
  for (const [projectId, info] of Object.entries(manifest.projects || {})) {
    if (info && info.modId) map.set(String(info.modId).toLowerCase(), { projectId, ...info });
  }
  return map;
}

function listInstalledMods(profilePath) {
  const dir = modsDir(profilePath);
  if (!fs.existsSync(dir)) return [];
  const manifest = readManifest(profilePath);
  const byFilename = new Map();
  for (const [projectId, info] of Object.entries(manifest.projects || {})) {
    if (info && info.filename) byFilename.set(info.filename, { projectId, ...info });
  }
  const byModId = manifestByModId(manifest);

  const mods = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !/\.jar(\.disabled)?$/i.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    let size = 0;
    try {
      size = fs.statSync(full).size;
    } catch {
      /* ignore */
    }
    const meta = jarMeta.readModMeta(full);
    const record = byFilename.get(entry.name) || (meta && meta.id ? byModId.get(meta.id.toLowerCase()) : null);
    mods.push({
      filename: entry.name,
      path: full,
      enabled: !entry.name.toLowerCase().endsWith(".disabled"),
      size,
      modId: (meta && meta.id) || (record && record.modId) || null,
      name: (meta && meta.name) || (record && record.name) || entry.name.replace(/\.jar(\.disabled)?$/i, ""),
      version: (meta && meta.version) || (record && record.version) || null,
      loader: (meta && meta.loader) || null,
      dependencies: (meta && meta.dependencies) || [],
      provides: (meta && meta.provides) || (meta && meta.id ? [meta.id] : []),
      embedded: (meta && meta.embedded) || [],
      projectId: record ? record.projectId : null,
      versionId: record ? record.versionId || null : null,
    });
  }
  mods.sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return mods;
}

function findInstalledByProject(profilePath, projectId) {
  const manifest = readManifest(profilePath);
  const info = manifest.projects[projectId];
  if (!info) return null;
  const full = path.join(modsDir(profilePath), info.filename);
  if (!fs.existsSync(full)) return null;
  return { ...info, projectId, path: full };
}

function removeManifestEntry(profilePath, projectId) {
  const manifest = readManifest(profilePath);
  if (manifest.projects[projectId]) {
    delete manifest.projects[projectId];
    writeManifest(profilePath, manifest);
  }
}

function recordInstall(profilePath, projectId, info) {
  const manifest = readManifest(profilePath);
  if (projectId) manifest.projects[projectId] = info;
  writeManifest(profilePath, manifest);
}

function uniqueDestination(dir, filename) {
  const base = path.basename(filename);
  let dest = path.join(dir, base);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length);
  let n = 2;
  while (fs.existsSync(dest)) {
    dest = path.join(dir, `${stem} (${n})${ext}`);
    n += 1;
  }
  return dest;
}

/**
 * Installs one mod file, replacing any existing jar with the same mod id or
 * the same Modrinth project. Returns a summary describing what was replaced.
 */
async function installResolvedVersion(profilePath, resolved, { gameVersion, loaders, onLog } = {}) {
  const log = (line) => onLog && onLog(line);
  const dir = modsDir(profilePath);
  fs.mkdirSync(dir, { recursive: true });

  const existingProject = resolved.projectId ? findInstalledByProject(profilePath, resolved.projectId) : null;
  if (existingProject && existingProject.versionId === resolved.versionId) {
    log(`[mods] ${resolved.projectName || resolved.filename} is already installed — skipping.\n`);
    return { installed: null, replaced: [], skipped: true };
  }

  const tempDir = path.join(profilePath, META_DIR, "tmp");
  fs.mkdirSync(tempDir, { recursive: true });
  const tempFile = path.join(tempDir, `${Date.now()}-${path.basename(resolved.filename)}`);
  await modrinth.downloadToFile(resolved.url, tempFile);

  const meta = jarMeta.readModMeta(tempFile);
  const installed = listInstalledMods(profilePath);
  const replaced = [];

  const clashing = installed.filter((mod) => {
    if (existingProject && mod.filename === existingProject.filename) return true;
    if (meta && meta.id && mod.modId && mod.modId.toLowerCase() === meta.id.toLowerCase()) return true;
    return false;
  });

  for (const mod of clashing) {
    try {
      fs.rmSync(mod.path, { force: true });
      replaced.push({ filename: mod.filename, modId: mod.modId, name: mod.name, version: mod.version });
      log(`[mods] Removed previous copy ${mod.filename} (${mod.name}) to avoid a duplicate install.\n`);
    } catch (err) {
      log(`[mods] Could not remove ${mod.filename}: ${err.message}\n`);
    }
  }

  const dest = path.join(dir, path.basename(resolved.filename));
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  fs.renameSync(tempFile, dest);

  recordInstall(profilePath, resolved.projectId, {
    filename: path.basename(dest),
    modId: meta ? meta.id : null,
    name: (meta && meta.name) || resolved.projectName || path.basename(dest),
    version: (meta && meta.version) || resolved.versionNumber || null,
    versionId: resolved.versionId,
    projectId: resolved.projectId || null,
    installedAt: Date.now(),
  });

  log(`[mods] Installed ${path.basename(dest)}${meta ? ` (${meta.name || meta.id})` : ""}.\n`);
  return {
    installed: {
      filename: path.basename(dest),
      modId: meta ? meta.id : null,
      name: (meta && meta.name) || resolved.projectName || path.basename(dest),
      version: (meta && meta.version) || resolved.versionNumber || null,
      projectId: resolved.projectId || null,
    },
    replaced,
    skipped: false,
  };
}

/**
 * Installs a Modrinth project version plus its required dependencies.
 * `visited` guards against dependency cycles.
 */
async function installProject(profilePath, projectId, versionId, options = {}) {
  const { gameVersion, loaders, autoDependencies = true, onLog, visited = new Set(), depth = 0 } = options;
  const log = (line) => onLog && onLog(line);
  const summary = { installed: [], replaced: [], missing: [], alreadyInstalled: [], dependencies: [] };

  const key = `${projectId}@${versionId}`;
  if (visited.has(key)) return summary;
  visited.add(key);

  const versions = await modrinth.getVersions(projectId, { gameVersion, loaders });
  const version = versions.find((v) => v.id === versionId) || (await modrinth.getVersion(versionId));
  if (!version) throw new Error("That mod version is no longer available.");

  const file = modrinth.primaryFile(version);
  if (!file || !file.url) throw new Error("The selected mod version has no downloadable file.");

  const project = await modrinth.getProject(projectId).catch(() => null);
  const resolved = {
    projectId,
    projectName: project ? project.title : null,
    projectIcon: project ? project.icon_url : null,
    versionId: version.id,
    versionNumber: version.version_number,
    filename: file.filename,
    url: file.url,
  };

  const result = await installResolvedVersion(profilePath, resolved, { gameVersion, loaders, onLog });
  if (result.skipped) {
    summary.alreadyInstalled.push({ ...resolved, modId: null });
  } else if (result.installed) {
    summary.installed.push(result.installed);
    summary.replaced.push(...result.replaced);
    if (result.replaced.length && result.replaced.some((r) => r.modId)) {
      // Replacing a mod invalidates the "is this dependency installed" view.
    }
  }

  const requiredDeps = (version.dependencies || []).filter((d) => d.dependency_type === "required");
  if (requiredDeps.length) {
    const plan = await modrinth.resolveVersionDependencies(version, { gameVersion, loaders });
    summary.dependencies.push(
      ...plan.map((dep) => ({
        projectId: dep.projectId,
        projectName: dep.projectName,
        resolved: !!dep.resolved,
        reason: dep.reason || null,
      }))
    );

    if (autoDependencies && depth < MAX_DEP_DEPTH) {
      for (const dep of plan) {
        if (!dep.resolved) {
          summary.missing.push({ name: dep.projectName, reason: dep.reason });
          log(`[mods] Missing required dependency: ${dep.projectName || "unknown"} — ${dep.reason}\n`);
          continue;
        }
        const already = findInstalledByProject(profilePath, dep.projectId);
        if (already) continue;
        log(`[mods] Installing required dependency ${dep.projectName} ${dep.versionNumber}…\n`);
        let nested;
        try {
          nested = await installProject(profilePath, dep.projectId, dep.versionId, {
            gameVersion,
            loaders,
            autoDependencies,
            onLog,
            visited,
            depth: depth + 1,
          });
        } catch (err) {
          summary.missing.push({ name: dep.projectName, reason: err.message });
          log(`[mods] Dependency ${dep.projectName} failed to install: ${err.message}\n`);
          continue;
        }
        summary.installed.push(...nested.installed);
        summary.replaced.push(...nested.replaced);
        summary.missing.push(...nested.missing);
        summary.alreadyInstalled.push(...nested.alreadyInstalled);
      }
    }
  }

  return summary;
}

/** Preview of required dependencies and whether this profile satisfies them. */
async function previewDependencies(profilePath, projectId, versionId, { gameVersion, loaders } = {}) {
  const version = await modrinth.getVersion(versionId);
  const plan = await modrinth.resolveVersionDependencies(version, { gameVersion, loaders });
  const manifest = readManifest(profilePath);
  return plan.map((dep) => ({
    projectId: dep.projectId,
    projectName: dep.projectName || dep.projectIcon || null,
    versionId: dep.versionId || null,
    versionNumber: dep.versionNumber || null,
    resolved: !!dep.resolved,
    reason: dep.reason || null,
    satisfied: !!(dep.projectId && manifest.projects[dep.projectId]),
  }));
}

function uninstallMod(profilePath, filename) {
  const safe = path.basename(String(filename || ""));
  if (!safe || safe !== filename) throw new Error("Invalid mod filename.");
  const dir = modsDir(profilePath);
  const target = path.join(dir, safe);
  if (!target.startsWith(dir)) throw new Error("Refusing to delete a file outside the mods folder.");
  if (!fs.existsSync(target)) throw new Error(`"${safe}" is not installed in this profile.`);
  fs.rmSync(target, { force: true });

  const manifest = readManifest(profilePath);
  for (const [projectId, info] of Object.entries(manifest.projects)) {
    if (info.filename === safe) delete manifest.projects[projectId];
  }
  writeManifest(profilePath, manifest);
  return { removed: safe };
}

/**
 * Builds the dependency tree for a profile.
 * `roots` are mods nothing else requires; each node lists its declared
 * dependencies with a satisfied flag and, when found, the providing mod.
 */
function buildDependencyTree(profilePath) {
  const mods = listInstalledMods(profilePath);
  const byModId = new Map();
  const providersById = new Map();
  for (const mod of mods) {
    for (const id of [mod.modId, ...(mod.provides || [])]) {
      if (!id) continue;
      const key = String(id).toLowerCase();
      if (!providersById.has(key)) providersById.set(key, mod);
    }
    if (mod.modId) byModId.set(mod.modId.toLowerCase(), mod);
  }

  const requiredBy = new Map();
  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      if (!dep.mandatory) continue;
      const key = String(dep.id).toLowerCase();
      const provider = providersById.get(key);
      if (!provider) continue;
      // A nested mod (XaeroLib inside Xaero's Minimap) is part of its parent,
      // so it must not make the parent look required by itself.
      if (!provider.modId || provider.modId.toLowerCase() !== key) continue;
      const set = requiredBy.get(provider.filename) || new Set();
      set.add(mod.filename);
      requiredBy.set(provider.filename, set);
    }
  }

  const seenNodes = new Map();
  function nodeFor(mod) {
    if (seenNodes.has(mod.filename)) return seenNodes.get(mod.filename);
    const deps = mod.dependencies.map((dep) => {
      const key = String(dep.id).toLowerCase();
      const provider = providersById.get(key);
      const embedded = !!(provider && provider.modId && provider.modId.toLowerCase() !== key);
      return {
        id: dep.id,
        mandatory: !!dep.mandatory,
        versionRange: dep.versionRange || null,
        satisfied: !!provider,
        embedded,
        provider: provider
          ? {
              filename: provider.filename,
              name: provider.name,
              version: provider.version,
              enabled: provider.enabled,
              embedded,
            }
          : null,
      };
    });
    const node = {
      filename: mod.filename,
      modId: mod.modId,
      name: mod.name,
      version: mod.version,
      loader: mod.loader,
      enabled: mod.enabled,
      size: mod.size,
      projectId: mod.projectId,
      provides: mod.provides || [],
      embedded: mod.embedded || [],
      requiredBy: Array.from(requiredBy.get(mod.filename) || []),
      dependencies: deps,
    };
    seenNodes.set(mod.filename, node);
    return node;
  }

  function nest(mod, stack) {
    const node = { ...nodeFor(mod), children: [] };
    if (stack.has(mod.filename)) return node;
    const nextStack = new Set(stack);
    nextStack.add(mod.filename);
    for (const dep of node.dependencies) {
      if (!dep.mandatory || !dep.satisfied || !dep.provider || dep.embedded) continue;
      const child = byModId.get(String(dep.id).toLowerCase());
      if (!child) continue;
      node.children.push(nest(child, nextStack));
    }
    return node;
  }

  const roots = mods.filter((mod) => !requiredBy.has(mod.filename));
  const missing = [];
  for (const mod of mods) {
    for (const dep of mod.dependencies) {
      if (dep.mandatory && !providersById.has(String(dep.id).toLowerCase())) {
        missing.push({ mod: mod.name, filename: mod.filename, dependency: dep.id, versionRange: dep.versionRange });
      }
    }
  }

  return {
    mods: mods.map((mod) => nodeFor(mod)),
    roots: roots.map((mod) => nest(mod, new Set())),
    missing,
    totalSize: mods.reduce((sum, mod) => sum + (mod.size || 0), 0),
  };
}

module.exports = {
  modsDir,
  listInstalledMods,
  findInstalledByProject,
  installProject,
  previewDependencies,
  uninstallMod,
  buildDependencyTree,
};
