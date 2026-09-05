"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // registry
  scanRegistry: () => ipcRenderer.invoke("registry:scan"),
  getRegistryInfo: () => ipcRenderer.invoke("registry:info"),
  setDefaultJvm: (jvmPath) => ipcRenderer.invoke("registry:setDefaultJvm", jvmPath),
  renameVersion: (oldName, newName) => ipcRenderer.invoke("registry:rename", { oldName, newName }),
  deleteVersion: (name) => ipcRenderer.invoke("registry:delete", name),
  deleteProfile: (name) => ipcRenderer.invoke("registry:delete", name),

  // java
  testJava: (jvmPath) => ipcRenderer.invoke("java:test", jvmPath),
  testJavaRuntime: (jvmPath) => ipcRenderer.invoke("java:test", jvmPath),
  setJavaRuntime: (jvmPath) => ipcRenderer.invoke("registry:setDefaultJvm", jvmPath),
  openJavaFolder: (jvmPath) => ipcRenderer.invoke("java:openFolder", jvmPath),
  chooseJavaFile: () => ipcRenderer.invoke("java:chooseFile"),
  installJdk26: () => ipcRenderer.invoke("java:installJdk26"),
  installJdk: (version) => ipcRenderer.invoke("java:installJdk", version),

  // files directory
  openUserDir: () => ipcRenderer.invoke("system:openUserDir"),
  openUserDirectory: () => ipcRenderer.invoke("system:openUserDir"),

  // settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  loadSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  setUserDir: (newDir) => ipcRenderer.invoke("settings:setUserDir", newDir),

  // file selection
  selectFile: (options) => ipcRenderer.invoke("file:select", options),

  // zip installs
  chooseZip: () => ipcRenderer.invoke("install:chooseZip"),
  installZip: (zipPath, name) => ipcRenderer.invoke("install:zip", { zipPath, name }),
  installFromZip: (zipPath, name) => ipcRenderer.invoke("install:zip", { zipPath, name }),

  // Mojang asset fetching
  listVersions: (typeFilter) => ipcRenderer.invoke("mojang:listVersions", typeFilter),
  listMojangVersions: (typeFilter) => ipcRenderer.invoke("mojang:listVersions", typeFilter),
  installVersion: (versionId, loader, loaderVersion, displayName, javaPath) =>
    ipcRenderer.invoke("mojang:install", { versionId, displayName, loader, loaderVersion, javaPath }),
  installMojangVersion: (versionId, displayName, loader) =>
    ipcRenderer.invoke("mojang:install", { versionId, displayName, loader }),
  listLoaderVersions: (loader, gameVersion) => ipcRenderer.invoke("loader:listVersions", { loader, gameVersion }),

  // Mods / Modrinth
  trendingMods: (family) => ipcRenderer.invoke("mods:trending", family),
  searchMods: (query, family) => ipcRenderer.invoke("mods:search", { query, family }),
  modVersions: (projectId, options) => ipcRenderer.invoke("mods:versions", { projectId, ...options }),
  installMod: (profileName, projectId, versionId) =>
    ipcRenderer.invoke("mods:install", { profileName, projectId, versionId }),

  // Launch
  launchProfile: (name, opts) => ipcRenderer.invoke("launch:start", { name, ...opts }),
  launch: (name, username, jvmGlobal) => ipcRenderer.invoke("launch:start", { name, username, jvmGlobal }),

  // Updates
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  performUpdate: () => ipcRenderer.invoke("updates:perform"),

  // Microsoft login (deprecated, but kept for compatibility)
  signIn: () => ipcRenderer.invoke("auth:signIn"),
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  getSession: () => ipcRenderer.invoke("auth:getSession"),

  // event streams
  onLogLine: (cb) => ipcRenderer.on("log:line", (_e, line) => cb(line)),
  onInstallProgress: (cb) => ipcRenderer.on("install:progress", (_e, info) => cb(info)),
  onJdkProgress: (cb) => ipcRenderer.on("jdk:progress", (_e, info) => cb(info)),
  onAuthProgress: (cb) => ipcRenderer.on("auth:progress", (_e, info) => cb(info)),
});

