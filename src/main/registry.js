"use strict";

const fs = require("fs");
const path = require("path");

function defaultIconPath() {
  return path.join(__dirname, "..", "..", "assets", "defaulticon.png");
}

function resolveIcon(dir, stored) {
  if (stored && fs.existsSync(stored)) return stored;
  const local = path.join(dir, "icon.png");
  if (fs.existsSync(local)) return local;
  const fallback = defaultIconPath();
  return fs.existsSync(fallback) ? fallback : null;
}

function makeRegistry(baseDir) {
  const versionsDir = path.join(baseDir, "versions");
  const registryFile = path.join(baseDir, "versions.json");
  fs.mkdirSync(versionsDir, { recursive: true });

  function load() {
    if (!fs.existsSync(registryFile)) return {};
    try {
      return JSON.parse(fs.readFileSync(registryFile, "utf-8"));
    } catch (err) {
      // The file exists but isn't valid JSON - most likely a previous
      // launch was killed/crashed mid-write. Back up the corrupt file
      // instead of silently discarding it (previously this returned {}
      // and the next save() would permanently overwrite real data with
      // nothing, with no visible error).
      const backupFile = `${registryFile}.corrupt-${Date.now()}.bak`;
      try {
        fs.copyFileSync(registryFile, backupFile);
        console.error(
          `[registry] ${registryFile} was corrupt and could not be parsed. ` +
            `A copy was saved to ${backupFile} for recovery. Starting from an empty registry. ` +
            `Original error: ${err.message}`
        );
      } catch (backupErr) {
        console.error(
          `[registry] ${registryFile} was corrupt and could not be parsed, ` +
            `and backing it up also failed: ${backupErr.message}`
        );
      }
      return {};
    }
  }

  function save(data) {
    // Write atomically: write to a temp file in the same directory, then
    // rename over the real file. A rename is atomic on POSIX and on
    // Windows (as long as source/dest are on the same volume, which they
    // are here), so a crash mid-write can never leave a half-written,
    // unparseable registryFile behind.
    const tmpFile = `${registryFile}.tmp-${process.pid}`;
    fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2));
    fs.renameSync(tmpFile, registryFile);
  }

  function scan() {
    const registry = load();
    const defaultJvm = registry.default_jvm || "";
    const cleaned = { default_jvm: defaultJvm };

    for (const [name, data] of Object.entries(registry)) {
      if (name === "default_jvm") continue;
      if (data && typeof data === "object" && data.path && fs.existsSync(data.path)) {
        cleaned[name] = {
          ...data,
          icon: resolveIcon(data.path, data.icon),
        };
      }
    }

    for (const entry of fs.readdirSync(versionsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(versionsDir, entry.name);
      const hasStart = fs.existsSync(path.join(dir, "start.py"));
      const hasJar = fs.existsSync(path.join(dir, `${entry.name}.jar`)) || fs.existsSync(path.join(dir, "client.jar"));
      const hasProfile = fs.existsSync(path.join(dir, "profile.json"));
      if (!hasStart && !hasJar && !hasProfile) continue;
      if (!cleaned[entry.name]) {
        cleaned[entry.name] = {
          path: dir,
          icon: resolveIcon(dir, null),
          jvm: null,
          source: hasJar || hasProfile ? "microsoft" : "zip",
        };
      } else {
        cleaned[entry.name].icon = resolveIcon(dir, cleaned[entry.name].icon);
      }
    }

    save(cleaned);
    return cleaned;
  }

  function setDefaultJvm(jvmPath) {
    const registry = load();
    registry.default_jvm = jvmPath;
    save(registry);
  }

  function upsert(name, data) {
    const registry = load();
    registry[name] = { ...(registry[name] || {}), ...data };
    save(registry);
    return registry;
  }

  function remove(name) {
    const registry = load();
    delete registry[name];
    save(registry);
  }

  function rename(oldName, newName) {
    const registry = load();
    if (registry[oldName]) {
      registry[newName] = registry[oldName];
      delete registry[oldName];
      save(registry);
    }
  }

  return { versionsDir, registryFile, load, save, scan, setDefaultJvm, upsert, remove, rename, defaultIconPath };
}

module.exports = { makeRegistry, defaultIconPath, resolveIcon };
