# Cuboid 4.0

Cuboid is the 4.0 revamp of SquareLauncher: an offline-mode Minecraft launcher for
Mojang installs with Fabric, Quilt, Forge and NeoForge support, a Modrinth
marketplace for mods **and resource packs**, per-profile memory tuning, and
dependency-aware mod installs.

The product, package id, visuals, colour scheme and logo are new in 4.0; the
launcher data layout (versions/, versions.json, start.py profiles) is unchanged
so existing 3.x profiles keep working.

## What's new

- **New identity**: Cuboid name, violet/teal design system, new cube logo
  (`assets/logo.svg`, regenerated PNG icons), rounded glass panels and a
  redesigned Home, Library, Discover, Settings and profile inspector.
- **Per-profile settings** via the three-dot menu on each profile card:
  - heap slider bounded by **2048 MiB** at the bottom and **system RAM − 1024 MiB**
    at the top, with the suggested value at half of RAM;
  - extra JVM arguments and a Java override just for that profile;
  - installed-mod dependency tree, profile folder, mods folder and resource
    packs folder shortcuts;
  - drag-and-drop resource pack import (`.zip` or pack folder).
- **Modrinth dependency checking**: required dependencies are resolved and
  installed recursively, optional/embedded/incompatible dependencies are
  reported, and a failed dependency is surfaced instead of silently skipped.
- **Duplicate-install protection**: each jar's real mod id is read from
  `fabric.mod.json` / `quilt.mod.json` / `mods.toml` inside the archive, so
  installing another version of the same mod replaces the old jar instead of
  leaving two copies In the mods folder.
- **Resource pack marketplace** and per-profile pack management.
- **Filter overrides**: every Discover filter (version, loader, category,
  environment, sort, licence) has an override that removes the profile-derived
  constraint for that dimension, plus an essential-filters group (compatible,
  hide installed, hide libraries, recently updated).
- **JDK downloading fixed**: Adoptium Temurin's API replaces the dead Oracle
  `download.oracle.com/java/<v>/latest/...` URLs that 404 in 3.0.17.
- **Microsoft sign-in removed entirely** (`msAuth.js`, auth IPC, preload auth
  API and stored sessions are gone). Cuboid is offline-mode only.
- **ZIP package installs are deprecated** in the UI and API response, but still
  functional for old 1.0 packages.

## Requirements

- Node.js 18+ and npm (for development only)
- Python 3 on `PATH` (profiles are launched through their generated `start.py`)
- A Java runtime — install one from **Settings → Java** (Adoptium Temurin) or
  point Cuboid at an existing JDK

## Run

```bash
npm install
npm start
```

Package with `npm run dist`. Rebuild the icon set with `npm run icons`
(requires Python 3 + Pillow).

## Layout

```
src/main/
  main.js          window, IPC, profile/settings wiring
  registry.js      versions.json registry + per-profile settings
  gameLauncher.js  memory bounds, start.py regeneration, process supervision
  startPyTemplate.js  generates start.py (heap + JVM args baked in)
  jdkInstall.js    Adoptium Temurin downloads + installed-JDK discovery
  modrinth.js      Modrinth search/facets/versions/dependencies
  jarMeta.js       dependency-free JAR metadata reader (mod id, deps, pack.mcmeta)
  mods.js          duplicate-safe installs, dependency resolution, dep tree
  resourcePacks.js resource pack list/import/delete/marketplace install
  mojangAssets.js  vanilla + loader installs
  forgeInstall.js  Forge/NeoForge installer bridge
  loaderMeta.js    Fabric/Quilt/Forge/NeoForge metadata
  cacheManager.js  shared library/asset/meta caches
  archNatives.js   arm64 LWJGL native override
  launchProfile.js launch plan construction
  updater.js       release feed check/apply
  zipInstall.js    deprecated ZIP package installer
src/renderer/      index.html, styles.css, app.js
tools/             icon generator + smoke tests
```

## Notes and limitations

- Profiles installed from **ZIP packages** ship their own `start.py`; Cuboid
  cannot regenerate it, so the heap slider and extra JVM args apply to
  Mojang/loader profiles only.
- The update feed still points at the legacy `SquareLauncher` repository until a
  Cuboid release channel exists, so 4.0 reports itself as up to date.
- Mod dependency checks use Modrinth's declared dependencies at install time and
  each jar's own metadata afterwards; version ranges are shown but not enforced.
