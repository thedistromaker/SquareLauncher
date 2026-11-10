"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const os = require("os");
const Store = require("electron-store");

const { makeRegistry } = require("./registry");
const { installZip } = require("./zipInstall");
const { installVersion, listAvailableVersions } = require("./mojangAssets");
const loaderMeta = require("./loaderMeta");
const { testJava, launchVersion, memoryBounds, clampMemory } = require("./gameLauncher");
const { installJdkVersion, listInstalledJdks } = require("./jdkInstall");
const cacheManager = require("./cacheManager");
const modrinth = require("./modrinth");
const mods = require("./mods");
const resourcePacks = require("./resourcePacks");
const pkg = require("../../package.json");

// ---------------------------------------------------------------------
// Launcher directory
// ---------------------------------------------------------------------
// The chosen directory is persisted inside Electron's real userData folder so
// it stays consistent across launches (terminal, desktop icon, autostart).
const defaultUserDataDir = app.getPath("userData");
const userDirPointerFile = path.join(defaultUserDataDir, "userDirPointer.json");

function directoryHasProfiles(dir) {
  try {
    const versionsDir = path.join(dir, "versions");
    if (!fs.existsSync(versionsDir)) return false;
    return fs.readdirSync(versionsDir, { withFileTypes: true }).some(
      (entry) => entry.isDirectory() && !entry.name.startsWith(".")
    );
  } catch {
    return false;
  }
}

// Cuboid renamed the app, which changes Electron's userData folder. On first
// run with an empty Cuboid folder, reuse a SquareLauncher folder that already
// contains profiles instead of showing an empty library.
function findLegacyUserDir() {
  try {
    const appData = app.getPath("appData");
    return (
      fs
        .readdirSync(appData, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && /^squarelauncher/i.test(entry.name))
        .map((entry) => path.join(appData, entry.name))
        .filter((dir) => dir !== defaultUserDataDir && directoryHasProfiles(dir))[0] || null
    );
  } catch {
    return null;
  }
}

function resolveUserDir() {
  if (fs.existsSync(userDirPointerFile)) {
    try {
      const pointer = JSON.parse(fs.readFileSync(userDirPointerFile, "utf-8"));
      if (pointer && pointer.userDir) {
        if (!directoryHasProfiles(pointer.userDir)) {
          const legacy = findLegacyUserDir();
          if (legacy) {
            fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: legacy }, null, 2));
            return legacy;
          }
        }
        return pointer.userDir;
      }
    } catch {
      /* re-derive below */
    }
  }
  let resolved = process.env.SQUARE_LAUNCHER_USER_DIR || defaultUserDataDir;
  if (!process.env.SQUARE_LAUNCHER_USER_DIR && !directoryHasProfiles(resolved)) {
    const legacy = findLegacyUserDir();
    if (legacy) resolved = legacy;
  }
  fs.mkdirSync(defaultUserDataDir, { recursive: true });
  fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: resolved }, null, 2));
  return resolved;
}

const USER_DIR = resolveUserDir();
if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });

const BASE_DIR = USER_DIR;
const registry = makeRegistry(BASE_DIR);
const store = new Store({ name: "cuboid-settings" });

cacheManager.init(BASE_DIR, () => {
  const settings = store.get("settings") || {};
  return { ...cacheManager.DEFAULT_CACHE_SETTINGS, ...(settings.caching || {}) };
});

let mainWindow;
let activeChild = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1380,
    height: 860,
    minWidth: 1080,
    minHeight: 660,
    backgroundColor: "#0b0c18",
    title: "Cuboid",
    icon: path.join(__dirname, "..", "..", "assets", "icons", "icon.png"),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "..", "preload", "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  mainWindow.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
}

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

function profileEntry(name) {
  const current = registry.scan();
  const entry = current[name];
  if (!entry || !entry.path) throw new Error(`Unknown profile "${name}".`);
  return entry;
}

function profilePathFor(name) {
  return profileEntry(name).path;
}

async function openDirectory(dir, label) {
  fs.mkdirSync(dir, { recursive: true });
  const err = await shell.openPath(dir);
  if (err) {
    shell.showItemInFolder(dir);
    throw new Error(`Could not open the ${label} folder: ${err}`);
  }
  return true;
}

// ---------------------------------------------------------------------
// Registry / settings
// ---------------------------------------------------------------------
ipcMain.handle("registry:scan", () => registry.scan());

ipcMain.handle("registry:info", () => ({
  versionsDir: registry.versionsDir,
  registryFile: registry.registryFile,
  userDir: USER_DIR,
}));

ipcMain.handle("registry:setDefaultJvm", (_e, jvmPath) => {
  registry.setDefaultJvm(jvmPath);
  return registry.scan();
});

ipcMain.handle("registry:rename", (_e, { oldName, newName }) => {
  const versionsDir = registry.versionsDir;
  const oldDir = path.join(versionsDir, oldName);
  const newDir = path.join(versionsDir, newName);
  if (fs.existsSync(newDir)) throw new Error("A profile with that name already exists.");
  if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
  registry.rename(oldName, newName);
  return registry.scan();
});

ipcMain.handle("registry:delete", (_e, name) => {
  if (!name) throw new Error("No profile selected to delete.");
  const target = path.join(registry.versionsDir, name);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  registry.remove(name);
  return registry.scan();
});

/**
 * Per-profile settings written from the three-dot profile menu:
 * heap size, extra JVM args and a Java override for just this profile.
 */
ipcMain.handle("registry:updateProfile", (_e, { name, patch }) => {
  if (!name || !patch || typeof patch !== "object") throw new Error("Invalid profile update.");
  const allowed = {};
  if (Object.prototype.hasOwnProperty.call(patch, "memoryMb")) {
    allowed.memoryMb = patch.memoryMb === null ? null : clampMemory(patch.memoryMb);
  }
  if (typeof patch.jvmArgs === "string") allowed.jvmArgs = patch.jvmArgs.trim();
  if (typeof patch.javaPath === "string") allowed.javaPath = patch.javaPath;
  const entry = registry.updateProfile(name, allowed);
  return { entry, registry: registry.scan(), bounds: memoryBounds() };
});

// ---------------------------------------------------------------------
// System / environment
// ---------------------------------------------------------------------
ipcMain.handle("system:info", () => ({
  app: {
    name: pkg.build && pkg.build.productName ? pkg.build.productName : "Cuboid",
    version: pkg.version,
    launcherVersion: pkg.launcherVersion,
    homepage: pkg.homepage,
  },
  platform: process.platform,
  arch: process.arch,
  cpus: os.cpus().length,
  totalMemoryMb: Math.floor(os.totalmem() / 1024 / 1024),
  freeMemoryMb: Math.floor(os.freemem() / 1024 / 1024),
  memoryBounds: memoryBounds(),
  userDir: USER_DIR,
  versionsDir: registry.versionsDir,
}));

ipcMain.handle("system:openPath", async (_e, target) => {
  if (!target || typeof target !== "string") throw new Error("No folder to open.");
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(USER_DIR)) && !resolved.startsWith(path.resolve(registry.versionsDir))) {
    throw new Error("Refusing to open a folder outside the launcher directory.");
  }
  return openDirectory(resolved, "requested");
});

ipcMain.handle("system:openHomepage", async () => {
  if (pkg.homepage) await shell.openExternal(pkg.homepage);
  return true;
});

ipcMain.handle("system:chooseDirectory", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openDirectory", "createDirectory"] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("file:select", async (_e, options) => {
  const res = await dialog.showOpenDialog(mainWindow, options || { properties: ["openFile"] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("files:selectMany", async (_e, filters) => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile", "multiSelections"],
    filters: filters || [{ name: "Archives", extensions: ["zip"] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths;
});

ipcMain.handle("system:openUserDir", async () => openDirectory(USER_DIR, "launcher"));

// ---------------------------------------------------------------------
// Java runtime
// ---------------------------------------------------------------------
ipcMain.handle("java:test", async (_e, jvmPath) => testJava(jvmPath));

ipcMain.handle("java:openFolder", (_e, jvmPath) => {
  if (jvmPath) shell.showItemInFolder(jvmPath);
});

ipcMain.handle("java:chooseFile", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("java:installed", () => listInstalledJdks(BASE_DIR));

ipcMain.handle("java:installJdk", async (_e, version, forceReinstall) => {
  const result = await installJdkVersion(
    BASE_DIR,
    version || "21",
    () => {},
    (info) => send("jdk:progress", info),
    !!forceReinstall
  );
  if (result && result.binaryPath) registry.setDefaultJvm(result.binaryPath);
  return result;
});

// ---------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------
ipcMain.handle("settings:get", () => {
  const saved = store.get("settings") || {};
  return {
    theme: "dark",
    jdkVersion: "21",
    userDir: USER_DIR,
    username: "Player",
    ...saved,
    caching: { ...cacheManager.DEFAULT_CACHE_SETTINGS, ...(saved.caching || {}) },
  };
});

ipcMain.handle("settings:set", (_e, patch) => {
  const cur = store.get("settings") || {};
  const merged = { ...cur, ...patch };
  if (patch && patch.caching) {
    merged.caching = { ...cacheManager.DEFAULT_CACHE_SETTINGS, ...(cur.caching || {}), ...patch.caching };
  }
  store.set("settings", merged);
  return merged;
});

ipcMain.handle("settings:setUserDir", (_e, newDir) => {
  if (!newDir || typeof newDir !== "string") throw new Error("Invalid user directory.");
  try {
    fs.mkdirSync(newDir, { recursive: true });
    fs.mkdirSync(defaultUserDataDir, { recursive: true });
    fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: newDir }, null, 2));
    return true;
  } catch (err) {
    throw new Error(`Failed to set user directory: ${err.message}`);
  }
});

ipcMain.handle("settings:migrateUserDir", async (_e, newDir) => {
  if (!newDir || typeof newDir !== "string") throw new Error("Invalid directory.");
  const resolvedNew = path.resolve(newDir);
  const resolvedCurrent = path.resolve(USER_DIR);
  if (resolvedNew === resolvedCurrent) throw new Error("That is already the current launcher directory.");

  fs.mkdirSync(resolvedNew, { recursive: true });
  if (fs.readdirSync(resolvedNew).length > 0) {
    throw new Error("The chosen directory isn't empty. Pick an empty folder for the migration.");
  }

  try {
    fs.cpSync(resolvedCurrent, resolvedNew, { recursive: true });
  } catch (err) {
    throw new Error(`Migration failed while copying files: ${err.message}`);
  }

  fs.mkdirSync(defaultUserDataDir, { recursive: true });
  fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: resolvedNew }, null, 2));
  return { newDir: resolvedNew, needsRestart: true };
});

// ---------------------------------------------------------------------
// Caching
// ---------------------------------------------------------------------
ipcMain.handle("cache:getStats", () => cacheManager.getCacheStats());
ipcMain.handle("cache:clear", (_e, category) => cacheManager.clearCache(category || "all"));

// ---------------------------------------------------------------------
// Legacy ZIP installs (deprecated)
// ---------------------------------------------------------------------
ipcMain.handle("install:chooseZip", async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ["openFile"],
    filters: [{ name: "Zip Packages", extensions: ["zip"] }],
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("install:zip", async (_e, { zipPath, name }) => {
  const entry = await installZip(zipPath, name, registry.versionsDir);
  registry.upsert(name, entry);
  return { registry: registry.scan(), deprecated: true };
});

// ---------------------------------------------------------------------
// Mojang / loaders
// ---------------------------------------------------------------------
ipcMain.handle("mojang:listVersions", async (_e, typeFilter) => listAvailableVersions(typeFilter));

ipcMain.handle("mojang:install", async (_e, { versionId, displayName, loader, loaderVersion, javaPath }) => {
  const loaderKind = loader || "vanilla";
  const suffix =
    loaderKind === "vanilla" ? "" : ` (${loaderKind[0].toUpperCase()}${loaderKind.slice(1)})`;
  const name = displayName && displayName.trim() ? displayName.trim() : `${versionId}${suffix}`;

  const destDir = path.join(registry.versionsDir, name);
  if (fs.existsSync(destDir)) {
    throw new Error(`A profile named "${name}" already exists. Pick a different display name.`);
  }

  const result = await installVersion(
    versionId,
    destDir,
    loaderKind,
    loaderVersion || null,
    null,
    (info) => send("install:progress", info),
    javaPath || registry.scan().default_jvm
  );

  registry.upsert(name, {
    ...result,
    path: result.path,
    icon: null,
    jvm: null,
    source: "microsoft",
    versionId,
    loader: loaderKind,
    loaderVersion: result.loaderVersion,
  });
  return { registry: registry.scan(), installed: name };
});

ipcMain.handle("loader:listVersions", async (_e, { loader, gameVersion }) => {
  if (!loader || loader === "vanilla") return [];
  const loaders = {
    fabric: loaderMeta.listFabricLoaderVersions,
    quilt: loaderMeta.listQuiltLoaderVersions,
    forge: loaderMeta.listForgeVersions,
    neoforge: loaderMeta.listNeoForgeVersions,
  };
  const list = loaders[loader];
  if (!list) throw new Error(`Unsupported loader "${loader}".`);
  const versions = await list(gameVersion);
  return versions.map((item) => (typeof item === "string" ? { version: item } : item));
});

// ---------------------------------------------------------------------
// Mods (Modrinth) — with duplicate + dependency handling
// ---------------------------------------------------------------------
ipcMain.handle("mods:search", async (_e, params = {}) => {
  try {
    return await modrinth.searchProjects(params);
  } catch (err) {
    console.error("mods:search error:", err);
    throw err;
  }
});

ipcMain.handle("mods:trending", async (_e, { family = "fabric", projectType = "mod", limit = 40 } = {}) => {
  try {
    return await modrinth.trending({ family, projectType, limit });
  } catch (err) {
    console.error("mods:trending error:", err);
    throw err;
  }
});

ipcMain.handle("mods:project", async (_e, projectId) => {
  if (!projectId) throw new Error("No project selected.");
  return modrinth.getProject(projectId);
});

ipcMain.handle("mods:versions", async (_e, { projectId, gameVersion, loader, family, allVersions }) => {
  if (!projectId) throw new Error("No mod project selected.");
  const loaders = family ? modrinth.familyLoaders(family) : loader ? modrinth.familyLoaders(loader) : [];
  return modrinth.getVersions(projectId, {
    gameVersion: allVersions ? undefined : gameVersion,
    loaders: loaders.length ? loaders : undefined,
  });
});

ipcMain.handle("mods:installed", (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return {
    mods: mods.listInstalledMods(entry.path),
    modsDir: mods.modsDir(entry.path),
  };
});

ipcMain.handle("mods:tree", (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return mods.buildDependencyTree(entry.path);
});

ipcMain.handle("mods:dependencies", async (_e, { profileName, projectId, versionId }) => {
  const entry = profileEntry(profileName);
  const loaders = entry.loader && entry.loader !== "vanilla" ? modrinth.familyLoaders(entry.loader) : [];
  return mods.previewDependencies(entry.path, projectId, versionId, {
    gameVersion: entry.versionId,
    loaders,
  });
});

ipcMain.handle("mods:install", async (_e, { profileName, projectId, versionId, autoDependencies = true }) => {
  if (!profileName || !projectId || !versionId) throw new Error("Profile, mod and version are required.");
  const entry = profileEntry(profileName);
  const loaders = entry.loader && entry.loader !== "vanilla" ? modrinth.familyLoaders(entry.loader) : [];
  const summary = await mods.installProject(entry.path, projectId, versionId, {
    gameVersion: entry.versionId,
    loaders,
    autoDependencies,
    onLog: () => {},
  });
  return { ...summary, profileName, tree: mods.buildDependencyTree(entry.path) };
});

ipcMain.handle("mods:uninstall", (_e, { profileName, filename }) => {
  const entry = profileEntry(profileName);
  const result = mods.uninstallMod(entry.path, filename);
  return { ...result, tree: mods.buildDependencyTree(entry.path) };
});

ipcMain.handle("mods:openFolder", async (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return openDirectory(mods.modsDir(entry.path), "mods");
});

// ---------------------------------------------------------------------
// Resource packs
// ---------------------------------------------------------------------
ipcMain.handle("packs:search", async (_e, { query = "", gameVersion, limit = 40 } = {}) => {
  return modrinth.searchProjects({
    query,
    projectType: "resourcepack",
    gameVersions: gameVersion && gameVersion !== "all" ? [gameVersion] : [],
    limit,
    index: query ? "relevance" : "downloads",
  });
});

ipcMain.handle("packs:list", (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return { packs: resourcePacks.listResourcePacks(entry.path), dir: resourcePacks.resourcePacksDir(entry.path) };
});

ipcMain.handle("packs:import", (_e, { profileName, paths }) => {
  const entry = profileEntry(profileName);
  return resourcePacks.importResourcePacks(entry.path, paths);
});

ipcMain.handle("packs:install", async (_e, { profileName, projectId, versionId }) => {
  const entry = profileEntry(profileName);
  return resourcePacks.installFromModrinth(entry.path, projectId, versionId);
});

ipcMain.handle("packs:delete", (_e, { profileName, name }) => {
  const entry = profileEntry(profileName);
  return resourcePacks.deleteResourcePack(entry.path, name);
});

ipcMain.handle("packs:openFolder", async (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return openDirectory(resourcePacks.resourcePacksDir(entry.path), "resourcepacks");
});

// ---------------------------------------------------------------------
// Profile folders
// ---------------------------------------------------------------------
ipcMain.handle("profile:openFolder", async (_e, { profileName }) => {
  const entry = profileEntry(profileName);
  return openDirectory(entry.path, "profile");
});

// ---------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------
ipcMain.handle("launch:start", async (_e, params = {}) => {
  const { name, username, jvmPath, memoryMb, extraJvmArgs } = params;
  if (!name) throw new Error("No profile selected to launch.");
  const entry = profileEntry(name);
  const settings = store.get("settings") || {};
  const bounds = memoryBounds();
  const requested = memoryMb == null ? entry.memoryMb ?? bounds.suggested : memoryMb;
  const clamped = clampMemory(requested);
  const jvmGlobal = jvmPath || registry.scan().default_jvm;

  activeChild = launchVersion({
    entry,
    profileName: name,
    username: username || settings.username || "Player",
    jvmGlobal,
    memoryMb: clamped,
    extraJvmArgs: extraJvmArgs != null ? extraJvmArgs : entry.jvmArgs || "",
    onLog: () => {},
  });
  return { memoryMb: clamped, bounds };
});

// ---------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------
const { checkForUpdate, performUpdate, readLocalVersion } = require("./updater");

ipcMain.handle("updates:check", async () => {
  try {
    return await checkForUpdate();
  } catch (err) {
    return { local: readLocalVersion(), remote: null, updateAvailable: false, error: err.message };
  }
});

ipcMain.handle("updates:perform", async () => performUpdate((info) => send("update:progress", info)));

app.on("before-quit", () => {
  if (activeChild && !activeChild.killed) {
    try {
      activeChild.kill();
    } catch {
      /* ignore */
    }
  }
});
