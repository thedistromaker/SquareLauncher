"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require("electron");
const path = require("path");
const fs = require("fs");
const Store = require("electron-store");

const { makeRegistry } = require("./registry");
const { installZip } = require("./zipInstall");
const { installVersion, listAvailableVersions } = require("./mojangAssets");
const { testJava, launchVersion } = require("./gameLauncher");
const { installJdkVersion } = require("./jdkInstall");
const msAuth = require("./msAuth");

// Directory where fetched/installed versions (zips, downloaded assets,
// libraries, etc.) are stored.
//
// The chosen directory is persisted to a small marker file inside
// Electron's real, always-available userData folder, so it stays
// consistent across launches regardless of how the app is started
// (terminal vs. desktop icon vs. autostart), which don't reliably carry
// the same environment variables. This avoids a bug where the app would
// silently use a different (empty) folder on a launch that didn't have
// SQUARE_LAUNCHER_USER_DIR set, making versions.json/JDK paths appear to
// "disappear."
//
// - First launch: SQUARE_LAUNCHER_USER_DIR (if set) or the default
//   userData path is used, and recorded in userDirPointer.json.
// - Every subsequent launch: whatever was recorded is used, ignoring the
//   env var, so the location never silently changes underneath you.
// - To intentionally move to a new location, delete userDirPointer.json
//   (in the default Electron userData folder) or edit it directly.
const defaultUserDataDir = app.getPath("userData");
const userDirPointerFile = path.join(defaultUserDataDir, "userDirPointer.json");

function resolveUserDir() {
  if (fs.existsSync(userDirPointerFile)) {
    try {
      const pointer = JSON.parse(fs.readFileSync(userDirPointerFile, "utf-8"));
      if (pointer && pointer.userDir) return pointer.userDir;
    } catch {
      // fall through to re-derive below
    }
  }

  const resolved = process.env.SQUARE_LAUNCHER_USER_DIR || defaultUserDataDir;
  fs.mkdirSync(defaultUserDataDir, { recursive: true });
  fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: resolved }, null, 2));
  return resolved;
}

const USER_DIR = resolveUserDir();
if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });

const BASE_DIR = USER_DIR;
const registry = makeRegistry(BASE_DIR);
const store = new Store({ name: "square-launcher-settings" });

let mainWindow;
let activeChild = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 800,
    minWidth: 1040,
    minHeight: 640,
    backgroundColor: "#12141a",
    title: "Square Launcher",
    icon: path.join(__dirname, "..", "..", "assets", "icons", "icon.png"),
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// ---------------------------------------------------------------------
// Registry / settings
// ---------------------------------------------------------------------
ipcMain.handle("registry:scan", () => registry.scan());

ipcMain.handle("registry:info", () => {
  return { versionsDir: registry.versionsDir, registryFile: registry.registryFile, userDir: USER_DIR };
});

ipcMain.handle("registry:setDefaultJvm", (_e, jvmPath) => {
  registry.setDefaultJvm(jvmPath);
  return registry.scan();
});

ipcMain.handle("registry:rename", (_e, { oldName, newName }) => {
  const versionsDir = registry.versionsDir;
  const oldDir = path.join(versionsDir, oldName);
  const newDir = path.join(versionsDir, newName);
  if (fs.existsSync(newDir)) throw new Error("A version with that name already exists.");
  if (fs.existsSync(oldDir)) fs.renameSync(oldDir, newDir);
  registry.rename(oldName, newName);
  return registry.scan();
});

ipcMain.handle("registry:delete", (_e, name) => {
  if (!name) throw new Error("No version selected to delete.");
  const target = path.join(registry.versionsDir, name);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  registry.remove(name);
  return registry.scan();
});

// ---------------------------------------------------------------------
// Java runtime
// ---------------------------------------------------------------------
ipcMain.handle("java:test", async (_e, jvmPath) => testJava(jvmPath));

ipcMain.handle("java:openFolder", (_e, jvmPath) => {
  shell.showItemInFolder(jvmPath);
});

ipcMain.handle("java:chooseFile", async () => {
  const res = await dialog.showOpenDialog(mainWindow, { properties: ["openFile"] });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle("java:installJdk26", async () => {
  // legacy entrypoint kept for compatibility; forwards to the parameterized installer
  return installJdkVersion(
    BASE_DIR,
    "26",
    (line) => send("log:line", line),
    (info) => send("jdk:progress", info)
  );
});

ipcMain.handle("java:installJdk", async (_e, version) => {
  const v = version || "26";
  return installJdkVersion(
    BASE_DIR,
    v,
    (line) => send("log:line", line),
    (info) => send("jdk:progress", info)
  );
});

// ---------------------------------------------------------------------
// Files directory
// ---------------------------------------------------------------------
ipcMain.handle("system:openUserDir", async () => {
  try {
    if (!fs.existsSync(USER_DIR)) fs.mkdirSync(USER_DIR, { recursive: true });
    // Try openPath first; if it returns a non-empty string it's an error message.
    const err = await shell.openPath(USER_DIR);
    if (err) {
      // fallback to showItemInFolder (best-effort)
      try {
        shell.showItemInFolder(USER_DIR);
      } catch (e) {
        // ignore
      }
      throw new Error(`Could not open files directory: ${err}`);
    }
    return true;
  } catch (err) {
    console.error("system:openUserDir failed:", err && err.message ? err.message : err);
    throw err;
  }
});

// ---------------------------------------------------------------------
// App settings
// ---------------------------------------------------------------------
ipcMain.handle("settings:get", () => {
  return store.get("settings") || { theme: "dark", jdkVersion: "26", userDir: USER_DIR };
});

ipcMain.handle("settings:set", (_e, patch) => {
  const cur = store.get("settings") || {};
  const merged = { ...cur, ...patch };
  store.set("settings", merged);
  return merged;
});

ipcMain.handle("settings:setUserDir", (_e, newDir) => {
  if (!newDir || typeof newDir !== "string") throw new Error("Invalid user directory");
  try {
    fs.mkdirSync(newDir, { recursive: true });
    fs.mkdirSync(defaultUserDataDir, { recursive: true });
    fs.writeFileSync(userDirPointerFile, JSON.stringify({ userDir: newDir }, null, 2));
    return true;
  } catch (err) {
    throw new Error(`Failed to set user directory: ${err.message}`);
  }
});

// ---------------------------------------------------------------------
// Zip installs (legacy path, still supported)
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
  return registry.scan();
});

// ---------------------------------------------------------------------
// Microsoft asset fetching (replaces "zip only")
// ---------------------------------------------------------------------
ipcMain.handle("mojang:listVersions", async (_e, typeFilter) => listAvailableVersions(typeFilter));

ipcMain.handle("mojang:install", async (_e, { versionId, displayName, loader, loaderVersion }) => {
  const loaderKind = loader || "vanilla";
  const suffix = loaderKind === "vanilla" ? "" : ` (${loaderKind[0].toUpperCase()}${loaderKind.slice(1)})`;
  const name = displayName && displayName.trim() ? displayName.trim() : `${versionId}${suffix}`;

  const session = store.get("session") || null;
  const destDir = path.join(registry.versionsDir, name);

  const result = await installVersion(versionId, destDir, loaderKind, loaderVersion || null, session, (info) =>
    send("install:progress", info)
  );

  registry.upsert(name, {
    path: result.path,
    icon: null,
    jvm: null,
    source: "microsoft",
    versionId,
    loader: loaderKind,
    loaderVersion: result.loaderVersion,
    credentialMode: result.credentialMode,
  });
  return registry.scan();
});

// ---------------------------------------------------------------------
// Microsoft login (rudimentary device-code sign in)
// ---------------------------------------------------------------------
ipcMain.handle("auth:signIn", async () => {
  try {
    const session = await msAuth.signIn((stage, extra) => send("auth:progress", { stage, ...extra }));
    store.set("session", {
      minecraftAccessToken: session.minecraftAccessToken,
      msRefreshToken: session.msRefreshToken,
      profile: session.profile,
      ownsGame: session.ownsGame,
      signedInAt: Date.now(),
    });
    return session;
  } catch (err) {
    send("auth:progress", { stage: "error", message: err.message });
    throw err;
  }
});

ipcMain.handle("auth:signOut", () => {
  store.delete("session");
  return true;
});

ipcMain.handle("auth:getSession", () => store.get("session") || null);

// ---------------------------------------------------------------------
// Launching
// ---------------------------------------------------------------------
ipcMain.handle("launch:start", async (_e, { name, username, jvmGlobal }) => {
  if (!name) throw new Error("No version selected to launch.");
  const currentRegistry = registry.scan();
  const entry = currentRegistry[name];
  if (!entry) throw new Error(`Unknown version "${name}".`);

  const onLog = (text) => send("log:line", text);
  const session = store.get("session") || null;

  send("log:line", `\nLaunching ${name}\n`);
  activeChild = launchVersion({ entry, username, jvmGlobal, session, onLog });
  return true;
});

app.on("before-quit", () => {
  if (activeChild && !activeChild.killed) {
    try {
      activeChild.kill();
    } catch {
      /* ignore */
    }
  }
});
