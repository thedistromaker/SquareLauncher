"use strict";

const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // registry / profile settings
  scanRegistry: () => ipcRenderer.invoke("registry:scan"),
  getRegistryInfo: () => ipcRenderer.invoke("registry:info"),
  setDefaultJvm: (jvmPath) => ipcRenderer.invoke("registry:setDefaultJvm", jvmPath),
  renameProfile: (oldName, newName) => ipcRenderer.invoke("registry:rename", { oldName, newName }),
  deleteProfile: (name) => ipcRenderer.invoke("registry:delete", name),
  updateProfile: (name, patch) => ipcRenderer.invoke("registry:updateProfile", { name, patch }),

  // java
  testJava: (jvmPath) => ipcRenderer.invoke("java:test", jvmPath),
  openJavaFolder: (jvmPath) => ipcRenderer.invoke("java:openFolder", jvmPath),
  chooseJavaFile: () => ipcRenderer.invoke("java:chooseFile"),
  installJdk: (version, forceReinstall) => ipcRenderer.invoke("java:installJdk", version, forceReinstall),
  getInstalledJdks: () => ipcRenderer.invoke("java:installed"),

  // system
  getSystemInfo: () => ipcRenderer.invoke("system:info"),
  openPath: (target) => ipcRenderer.invoke("system:openPath", target),
  openUserDir: () => ipcRenderer.invoke("system:openUserDir"),
  chooseDirectory: () => ipcRenderer.invoke("system:chooseDirectory"),
  selectFile: (options) => ipcRenderer.invoke("file:select", options),
  selectFiles: (filters) => ipcRenderer.invoke("files:selectMany", filters),
  openHomepage: () => ipcRenderer.invoke("system:openHomepage"),
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return file && file.path ? file.path : null;
    }
  },

  // settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  saveSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  setUserDir: (newDir) => ipcRenderer.invoke("settings:setUserDir", newDir),
  migrateUserDir: (newDir) => ipcRenderer.invoke("settings:migrateUserDir", newDir),

  // caching
  getCacheStats: () => ipcRenderer.invoke("cache:getStats"),
  clearCache: (category) => ipcRenderer.invoke("cache:clear", category),

  // legacy zip
  chooseZip: () => ipcRenderer.invoke("install:chooseZip"),
  installZip: (zipPath, name) => ipcRenderer.invoke("install:zip", { zipPath, name }),

  // mojang
  listVersions: (typeFilter) => ipcRenderer.invoke("mojang:listVersions", typeFilter),
  installVersion: (versionId, loader, loaderVersion, displayName, javaPath) =>
    ipcRenderer.invoke("mojang:install", { versionId, displayName, loader, loaderVersion, javaPath }),
  listLoaderVersions: (loader, gameVersion) => ipcRenderer.invoke("loader:listVersions", { loader, gameVersion }),

  // mods
  searchMods: (params) => ipcRenderer.invoke("mods:search", params),
  trendingMods: (params) => ipcRenderer.invoke("mods:trending", params),
  getModProject: (projectId) => ipcRenderer.invoke("mods:project", projectId),
  modVersions: (projectId, options) => ipcRenderer.invoke("mods:versions", { projectId, ...options }),
  installedMods: (profileName) => ipcRenderer.invoke("mods:installed", { profileName }),
  modTree: (profileName) => ipcRenderer.invoke("mods:tree", { profileName }),
  modDependencies: (profileName, projectId, versionId) =>
    ipcRenderer.invoke("mods:dependencies", { profileName, projectId, versionId }),
  installMod: (profileName, projectId, versionId, autoDependencies) =>
    ipcRenderer.invoke("mods:install", { profileName, projectId, versionId, autoDependencies }),
  uninstallMod: (profileName, filename) => ipcRenderer.invoke("mods:uninstall", { profileName, filename }),
  openModsFolder: (profileName) => ipcRenderer.invoke("mods:openFolder", { profileName }),

  // resource packs
  searchPacks: (params) => ipcRenderer.invoke("packs:search", params),
  listPacks: (profileName) => ipcRenderer.invoke("packs:list", { profileName }),
  importPacks: (profileName, paths) => ipcRenderer.invoke("packs:import", { profileName, paths }),
  installPack: (profileName, projectId, versionId) =>
    ipcRenderer.invoke("packs:install", { profileName, projectId, versionId }),
  deletePack: (profileName, name) => ipcRenderer.invoke("packs:delete", { profileName, name }),
  openResourcePacksFolder: (profileName) => ipcRenderer.invoke("packs:openFolder", { profileName }),

  // profile folder
  openProfileFolder: (profileName) => ipcRenderer.invoke("profile:openFolder", { profileName }),

  // launch
  launchProfile: (name, opts) => ipcRenderer.invoke("launch:start", { name, ...opts }),

  // updates
  checkForUpdate: () => ipcRenderer.invoke("updates:check"),
  performUpdate: () => ipcRenderer.invoke("updates:perform"),

  // event streams
  onInstallProgress: (cb) => ipcRenderer.on("install:progress", (_e, info) => cb(info)),
  onJdkProgress: (cb) => ipcRenderer.on("jdk:progress", (_e, info) => cb(info)),
  onUpdateProgress: (cb) => ipcRenderer.on("update:progress", (_e, info) => cb(info)),
});
