"use strict";

const fs = require("fs");
const path = require("path");
const extract = require("extract-zip");

async function installZip(zipPath, name, versionsDir) {
  const target = path.join(versionsDir, name);
  if (fs.existsSync(target)) {
    fs.rmSync(target, { recursive: true, force: true });
  }
  fs.mkdirSync(target, { recursive: true });

  await extract(zipPath, { dir: target });

  const hasStart = fs.existsSync(path.join(target, "start.py"));
  if (!hasStart) {
    throw new Error("Invalid package (missing start.py)");
  }

  return {
    path: target,
    icon: fs.existsSync(path.join(target, "icon.png")) ? path.join(target, "icon.png") : null,
    jvm: null,
    source: "zip",
  };
}

module.exports = { installZip };
