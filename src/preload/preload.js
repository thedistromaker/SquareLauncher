"use strict";

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("api", {
  // registry
  scanRegistry: () => ipcRenderer.invoke("registry:scan"),
  getRegistryInfo: () => ipcRenderer.invoke("registry:info"),
  setDefaultJvm: (jvmPath) => ipcRenderer.invoke("registry:setDefaultJvm", jvmPath),
  renameVersion: (oldName, newName) => ipcRenderer.invoke("registry:rename", { oldName, newName }),
  deleteVersion: (name) => ipcRenderer.invoke("registry:delete", name),

  // java
  testJava: (jvmPath) => ipcRenderer.invoke("java:test", jvmPath),
  openJavaFolder: (jvmPath) => ipcRenderer.invoke("java:openFolder", jvmPath),
  chooseJavaFile: () => ipcRenderer.invoke("java:chooseFile"),
  installJdk26: () => ipcRenderer.invoke("java:installJdk26"),
  installJdk: (version) => ipcRenderer.invoke("java:installJdk", version),

  // files directory
  openUserDir: () => ipcRenderer.invoke("system:openUserDir"),

  // settings
  getSettings: () => ipcRenderer.invoke("settings:get"),
  setSettings: (patch) => ipcRenderer.invoke("settings:set", patch),
  setUserDir: (newDir) => ipcRenderer.invoke("settings:setUserDir", newDir),

  // zip installs
  chooseZip: () => ipcRenderer.invoke("install:chooseZip"),
  installZip: (zipPath, name) => ipcRenderer.invoke("install:zip", { zipPath, name }),

  // Microsoft asset fetching
  listMojangVersions: (typeFilter) => ipcRenderer.invoke("mojang:listVersions", typeFilter),
  installMojangVersion: (versionId, displayName, loader) =>
    ipcRenderer.invoke("mojang:install", { versionId, displayName, loader }),

  // Microsoft login
  signIn: () => ipcRenderer.invoke("auth:signIn"),
  signOut: () => ipcRenderer.invoke("auth:signOut"),
  getSession: () => ipcRenderer.invoke("auth:getSession"),

  // launching
  launch: (name, username, jvmGlobal) => ipcRenderer.invoke("launch:start", { name, username, jvmGlobal }),

  // event streams
  onLogLine: (cb) => ipcRenderer.on("log:line", (_e, line) => cb(line)),
  onInstallProgress: (cb) => ipcRenderer.on("install:progress", (_e, info) => cb(info)),
  onJdkProgress: (cb) => ipcRenderer.on("jdk:progress", (_e, info) => cb(info)),
  onAuthProgress: (cb) => ipcRenderer.on("auth:progress", (_e, info) => cb(info)),
});
