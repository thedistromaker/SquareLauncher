"use strict";

const fs = require("fs");
const path = require("path");
const extract = require("extract-zip");

/**
 * Legacy 1.0 zip package installer.
 *
 * DEPRECATED in 4.0: zip packages predate Mojang/loader installs, are
 * verified only by the presence of start.py, and cannot be updated or have
 * their dependencies resolved. Kept working for existing packages, but the
 * UI labels it clearly and new profiles should use Mojang/Fabric/Quilt/
 * Forge/NeoForge installs instead.
 */
async function installZip(zipPath, name, versionsDir) {
  const target = path.join(versionsDir, name);
  if (fs.existsSync(target)) fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(target, { recursive: true });

  await extract(zipPath, { dir: target });

  if (!fs.existsSync(path.join(target, "start.py"))) {
    throw new Error("Invalid package (missing start.py).");
  }

  return {
    path: target,
    icon: fs.existsSync(path.join(target, "icon.png")) ? path.join(target, "icon.png") : null,
    jvm: null,
    source: "zip",
    deprecated: true,
  };
}

module.exports = { installZip };
