"use strict";

/* ============================================================================
   Cuboid 4.0 renderer
   ========================================================================== */

const $ = (id) => document.getElementById(id);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
// contextBridge exposes `window.api` as a read-only global property. A
// top-level `const api` would collide with it and abort the whole script.
const bridge = window.api;

const state = {
  info: null,
  registry: {},
  profileList: [],
  settings: { username: "Player", theme: "dark" },
  activeProfile: null,
  view: "home",
  settingsTab: "general",
  installed: { projectIds: new Set(), names: new Set(), modIds: new Set(), versionIds: new Set(), projectVersions: new Map() },
  disc: {
    tab: "mod",
    query: "",
    hits: [],
    requestId: 0,
    selected: null,
    versions: [],
  },
  filters: {
    versionOverride: false,
    loaderOverride: false,
    loaders: [],
    category: "",
    customCategory: "",
    categoryOverride: false,
    environment: "client",
    environmentOverride: false,
    sort: "downloads",
    sortOverride: false,
    licenseOverride: false,
    license: "",
    openSource: false,
    essentials: { compatible: true, hideInstalled: true, hideLibraries: false, recent: false },
  },
  profileModal: { name: null, tree: null, packs: [] },
  settingsProfile: null,
  add: { loader: "vanilla", versionType: "release" },
};

const CATEGORIES_ESSENTIAL = [
  "optimization",
  "utility",
  "library",
  "adventure",
  "decoration",
  "equipment",
  "technology",
  "magic",
  "worldgen",
  "storage",
];

const CATEGORIES_FULL = [
  "adventure",
  "cursed",
  "decoration",
  "economy",
  "equipment",
  "food",
  "game-mechanics",
  "library",
  "magic",
  "management",
  "minigame",
  "mobs",
  "optimization",
  "social",
  "storage",
  "technology",
  "transportation",
  "utility",
  "worldgen",
];

const LOADERS = ["fabric", "quilt", "forge", "neoforge"];

const VIEW_LABELS = {
  home: "Home",
  library: "Library",
  discover: "Discover",
  settings: "Settings",
  updates: "Updates",
};

/* ============================================================================
   Small helpers
   ========================================================================== */
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));

const norm = (value) => String(value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");

function iconSrc(iconPath) {
  if (!iconPath) return "../../assets/logo.svg";
  return encodeURI(`file://${String(iconPath).replace(/\\/g, "/")}`);
}

function formatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB"];
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
  return `${Math.round((n / 1024 ** i) * 100) / 100} ${units[i]}`;
}

function formatCount(value) {
  const n = Number(value) || 0;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function loaderLabel(entry) {
  const loader = entry && entry.loader ? entry.loader : "vanilla";
  if (loader === "vanilla") return "Vanilla";
  if (loader === "neoforge") return "NeoForge";
  if (loader === "fabric") return "Fabric";
  if (loader === "quilt") return "Quilt";
  if (loader === "forge") return "Forge";
  return loader.charAt(0).toUpperCase() + loader.slice(1);
}

function toast(message, kind = "ok") {
  const container = $("toasts");
  const node = document.createElement("div");
  node.className = `toast ${kind}`;
  node.innerHTML = `<span class="toast-dot"></span><span>${esc(message)}</span>`;
  container.appendChild(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(6px)";
    node.style.transition = "all 200ms";
    setTimeout(() => node.remove(), 220);
  }, 4200);
}

function showError(message, context = "Cuboid") {
  const detail = $("errorDetail");
  if (!detail || !$("errorModal")) {
    toast(String(message || "Unknown error"), "err");
    return;
  }
  if ($("errorTitle")) $("errorTitle").textContent = "Something went wrong";
  if ($("errorContext")) $("errorContext").textContent = context ? String(context) : "";
  detail.textContent = String(message || "Unknown error");
  showModal("errorModal");
}

function showModal(id) {
  const node = $(id);
  if (node) node.hidden = false;
}

function hideModal(id) {
  const node = $(id);
  if (node) node.hidden = true;
}

async function call(label, fn) {
  try {
    return await fn();
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    showError(message, label);
    return null;
  }
}

function activeEntry() {
  return state.activeProfile ? state.registry[state.activeProfile] || null : null;
}

function profileNames() {
  return state.profileList.slice();
}

function profileOptions(selected) {
  return profileNames()
    .map((name) => `<option value="${esc(name)}"${name === selected ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
}

/* ============================================================================
   Bootstrap
   ========================================================================== */
async function init() {
  try {
    bindUi();
  } catch (err) {
    showError(err.message, "Binding the Cuboid interface");
  }

  if (!bridge) {
    showError(
      "The Electron preload bridge did not load. Launch Cuboid with npm start (or the packaged app) instead of opening index.html directly.",
      "Cuboid could not start"
    );
    return;
  }

  try {
    state.info = await bridge.getSystemInfo();
  } catch (err) {
    showError(err.message, "Reading system info");
  }

  if (state.info) {
    if ($("brandVersion")) $("brandVersion").textContent = `v${state.info.app.version}`;
    document.title = `Cuboid ${state.info.app.version}`;
  }

  try {
    state.settings = { ...state.settings, ...(await bridge.getSettings()) };
  } catch (err) {
    showError(err.message, "Loading settings");
  }

  applyTheme(state.settings.theme === "light");
  if ($("usernameInput")) $("usernameInput").value = state.settings.username || "Player";
  if ($("playerName")) $("playerName").textContent = state.settings.username || "Player";

  await refreshRegistry();
  showView("home");

  bridge.onInstallProgress(handleInstallProgress);
  bridge.onJdkProgress(handleJdkProgress);
  bridge.onUpdateProgress(handleUpdateProgress);
}

/* ============================================================================
   Registry / active profile
   ========================================================================== */
async function refreshRegistry() {
  const registry = await call("Loading profiles", () => bridge.scanRegistry());
  if (!registry) return;
  state.registry = registry;
  state.profileList = Object.keys(registry).filter((name) => name !== "default_jvm");

  const stored = localStorage.getItem("cuboid.activeProfile");
  if (!state.activeProfile || !state.profileList.includes(state.activeProfile)) {
    state.activeProfile =
      stored && state.profileList.includes(stored) ? stored : state.profileList[0] || null;
  }
  if (state.activeProfile) localStorage.setItem("cuboid.activeProfile", state.activeProfile);
  else localStorage.removeItem("cuboid.activeProfile");

  renderProfileSwitchers();
  await loadInstalledForActive();
}

async function loadInstalledForActive() {
  state.installed = {
    projectIds: new Set(),
    names: new Set(),
    modIds: new Set(),
    versionIds: new Set(),
    projectVersions: new Map(),
  };
  if (!state.activeProfile) return;
  try {
    const result = await bridge.installedMods(state.activeProfile);
    for (const mod of result.mods || []) {
      if (mod.projectId) state.installed.projectIds.add(mod.projectId);
      if (mod.name) state.installed.names.add(norm(mod.name));
      if (mod.modId) state.installed.modIds.add(norm(mod.modId));
      if (mod.versionId) {
        state.installed.versionIds.add(mod.versionId);
        if (mod.projectId) state.installed.projectVersions.set(mod.projectId, mod.versionId);
      }
    }
  } catch (err) {
    toast(`Could not scan installed mods: ${err.message}`, "warn");
  }
}

async function setActiveProfile(name) {
  state.activeProfile = name || null;
  if (name) localStorage.setItem("cuboid.activeProfile", name);
  renderProfileSwitchers();
  await loadInstalledForActive();
  if (state.view === "home") renderHome();
  if (state.view === "library") renderLibrary();
  if (state.view === "discover") loadDiscover();
  if (state.view === "settings" && state.settingsTab === "profiles") loadSettingsProfile();
}

function renderProfileSwitchers() {
  const select = $("activeProfileSelect");
  if (select) {
    if (!state.profileList.length) {
      select.innerHTML = `<option value="">No profiles</option>`;
      select.disabled = true;
    } else {
      select.disabled = false;
      select.innerHTML = profileOptions(state.activeProfile);
    }
  }
  const settingsSelect = $("settingsProfileSelect");
  if (settingsSelect) {
    settingsSelect.innerHTML = profileOptions(state.settingsProfile || state.activeProfile);
    settingsSelect.disabled = !state.profileList.length;
  }
}

/* ============================================================================
   Views
   ========================================================================== */
function showView(view) {
  state.view = view;
  $$(".view").forEach((node) => (node.hidden = true));
  const target = $(`${view}View`);
  if (target) target.hidden = false;
  $$(".nav-item").forEach((item) => item.classList.toggle("active", item.dataset.view === view));
  if ($("crumbView")) $("crumbView").textContent = VIEW_LABELS[view] || view;
  $("workspace").scrollTop = 0;

  if (view === "home") renderHome();
  else if (view === "library") renderLibrary();
  else if (view === "discover") renderDiscover();
  else if (view === "settings") renderSettings();
  else if (view === "updates") renderUpdates();
}

function renderHome() {
  const entry = activeEntry();
  const bounds = state.info && state.info.memoryBounds ? state.info.memoryBounds : { min: 2048, max: 8192, totalMb: 0, suggested: 4096 };

  if ($("statProfiles")) $("statProfiles").textContent = String(state.profileList.length);
  if ($("homeHeroSub")) {
    $("homeHeroSub").textContent = entry
      ? `${state.activeProfile} · ${loaderLabel(entry)}${entry.versionId ? ` ${entry.versionId}` : ""}`
      : "No profiles installed yet. Create one in Library.";
  }

  const memory = entry && entry.memoryMb ? entry.memoryMb : bounds.suggested;
  if ($("statMemory")) $("statMemory").textContent = entry ? `${memory} MiB` : "—";
  if ($("statMemorySub")) {
    $("statMemorySub").textContent = entry
      ? `of ${bounds.max} MiB allowed (RAM − 1024 MiB)`
      : "allocated to the active profile";
  }

  const jvm = (state.registry.default_jvm || "").trim();
  if ($("statJava")) $("statJava").textContent = jvm ? jvm.split(/[\\/]/).slice(-1)[0] : "Not set";
  if ($("statJavaSub")) $("statJavaSub").textContent = jvm ? jvm : "install a JDK in Settings → Java";

  if ($("homeMemoryHint")) {
    $("homeMemoryHint").textContent = state.info
      ? `System RAM ${state.info.memoryBounds.totalMb} MiB · heap range ${state.info.memoryBounds.min}–${state.info.memoryBounds.max} MiB per profile.`
      : "";
  }

  const playBtn = $("homePlayBtn");
  if (playBtn) playBtn.disabled = !entry;

  const quick = $("homeQuickProfiles");
  if (quick) {
    quick.innerHTML = "";
    const entries = state.profileList.slice(0, 4);
    if (!entries.length) {
      quick.innerHTML = `<p class="hint">Nothing installed yet — your first profile will show up here.</p>`;
    }
    for (const name of entries) {
      const data = state.registry[name];
      const button = document.createElement("button");
      button.type = "button";
      button.className = "quick-card";
      button.dataset.profile = name;
      button.innerHTML = `
        <img src="${esc(iconSrc(data.icon))}" alt="" />
        <span class="quick-meta">
          <span class="quick-name">${esc(name)}</span>
          <span class="quick-sub">${esc(loaderLabel(data))}${data.versionId ? ` · ${esc(data.versionId)}` : ""}</span>
        </span>`;
      quick.appendChild(button);
    }
  }
}

function renderLibrary() {
  const grid = $("libraryGrid");
  const empty = $("libraryEmpty");
  if (!grid) return;

  if (!state.profileList.length) {
    grid.innerHTML = "";
    if (empty) empty.hidden = false;
    return;
  }
  if (empty) empty.hidden = true;

  const bounds = state.info && state.info.memoryBounds ? state.info.memoryBounds : { suggested: 4096, max: 8192 };
  grid.innerHTML = state.profileList
    .map((name) => {
      const data = state.registry[name];
      const memory = data.memoryMb || bounds.suggested;
      return `
      <article class="profile-card${name === state.activeProfile ? " active" : ""}" data-profile="${esc(name)}">
        <div class="profile-top">
          <div class="profile-icon">
            <img src="${esc(iconSrc(data.icon))}" alt="" />
          </div>
          <button class="icon-btn kebab" data-kebab="${esc(name)}" title="Profile settings" aria-label="Settings for ${esc(name)}">⋯</button>
        </div>
        <h3 class="profile-name">${esc(name)}</h3>
        <div class="badge-row">
          <span class="badge">${esc(loaderLabel(data))}</span>
          ${data.versionId ? `<span class="badge badge-muted">${esc(data.versionId)}</span>` : ""}
          ${data.loaderVersion ? `<span class="badge badge-muted">${esc(data.loaderVersion)}</span>` : ""}
          ${data.source === "zip" ? `<span class="badge badge-warn">legacy zip</span>` : ""}
        </div>
        <div class="profile-foot">
          <span class="hint mono">${memory} MiB</span>
          <button class="btn btn-primary btn-sm profile-play" data-play="${esc(name)}">Play</button>
        </div>
      </article>`;
    })
    .join("");
}

async function renderDiscover() {
  $$("[data-market]").forEach((btn) => {
    const active = btn.dataset.market === state.disc.tab;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", String(active));
  });
  const search = $("discoverSearch");
  if (search && search.value !== state.disc.query) search.value = state.disc.query;

  if ($("discoverSub")) {
    $("discoverSub").textContent =
      state.disc.tab === "pack"
        ? "Resource packs from Modrinth — install straight into the active profile."
        : "Mods from Modrinth, with dependency and duplicate checks.";
  }
  if ($("discoverSearch")) {
    $("discoverSearch").placeholder =
      state.disc.tab === "pack" ? "Search resource packs…" : "Search mods…";
  }

  populateFiltersUi();
  renderFilterChips();
  await loadDiscover();
}

async function loadDiscover() {
  const grid = $("discoverGrid");
  if (!grid) return;
  const requestId = ++state.disc.requestId;
  grid.innerHTML = `<p class="hint">Loading ${state.disc.tab === "pack" ? "resource packs" : "mods"}…</p>`;

  const params = buildDiscoverParams();
  let result = null;
  try {
    result = state.disc.tab === "pack" ? await bridge.searchPacks(params) : await bridge.searchMods(params);
  } catch (err) {
    if (requestId !== state.disc.requestId) return;
    grid.innerHTML = "";
    if ($("discoverEmpty")) {
      $("discoverEmpty").hidden = false;
      $("discoverEmptyText").textContent = `Modrinth could not be reached: ${err.message}`;
    }
    return;
  }
  if (requestId !== state.disc.requestId) return;

  let hits = Array.isArray(result) ? result : Array.isArray(result && result.hits) ? result.hits : [];
  hits = filterHits(hits);
  state.disc.hits = hits;

  if (!hits.length) {
    grid.innerHTML = "";
    if ($("discoverEmpty")) {
      $("discoverEmpty").hidden = false;
      $("discoverEmptyText").textContent =
        "Nothing matched. Try loosening a filter override or searching something else.";
    }
    return;
  }
  if ($("discoverEmpty")) $("discoverEmpty").hidden = true;
  grid.innerHTML = hits.map(itemCardHtml).join("");
}

function buildDiscoverParams() {
  const f = state.filters;
  const isPack = state.disc.tab === "pack";
  const entry = activeEntry();

  const loaders = [];
  if (!isPack && f.essentials.compatible && entry && entry.loader && entry.loader !== "vanilla") {
    if (f.loaderOverride) loaders.push(...(f.loaders.length ? f.loaders : [entry.loader]));
    else loaders.push(entry.loader);
  } else if (!isPack && f.loaderOverride && f.loaders.length) {
    loaders.push(...f.loaders);
  }

  const gameVersions = [];
  if (f.essentials.compatible && !f.versionOverride && entry && entry.versionId) {
    gameVersions.push(entry.versionId);
  }

  const categories = [];
  if (f.category) categories.push(f.category);
  if (f.categoryOverride && f.customCategory.trim()) categories.push(f.customCategory.trim());

  return {
    query: state.disc.query,
    projectType: isPack ? "resourcepack" : "mod",
    loaders,
    gameVersions,
    categories,
    environment: isPack ? "" : f.environmentOverride ? f.environment : "client",
    index: f.sort,
    openSource: f.openSource,
    licenses: f.license ? [f.license] : [],
    limit: 60,
  };
}

function isHitInstalled(hit) {
  if (!hit) return false;
  if (hit.project_id && state.installed.projectIds.has(hit.project_id)) return true;
  return [hit.slug, hit.title]
    .filter(Boolean)
    .map(norm)
    .some((key) => state.installed.names.has(key) || state.installed.modIds.has(key));
}

function filterHits(hits) {
  const essentials = state.filters.essentials;
  return hits.filter((hit) => {
    if (state.disc.tab === "mod" && essentials.hideInstalled && isHitInstalled(hit)) return false;
    if (essentials.hideLibraries && Array.isArray(hit.categories) && hit.categories.includes("library")) {
      return false;
    }
    if (essentials.recent && hit.date_modified) {
      const age = Date.now() - new Date(hit.date_modified).getTime();
      if (Number.isFinite(age) && age > 30 * 86_400_000) return false;
    }
    return true;
  });
}

function itemCardHtml(hit) {
  const installed = state.disc.tab === "mod" && isHitInstalled(hit);

  const categories = Array.isArray(hit.categories) ? hit.categories.slice(0, 3) : [];
  return `
  <article class="mod-card${installed ? " installed" : ""}" data-project="${esc(hit.project_id)}">
    <div class="mod-card-top">
      <img class="mod-thumb" src="${esc(hit.icon_url || "../../assets/logo.svg")}" alt="" loading="lazy" />
      <div class="mod-title-wrap">
        <h4>${esc(hit.title)}</h4>
        <span class="muted small">${esc(hit.author || "unknown author")}</span>
      </div>
    </div>
    <p class="mod-desc">${esc(hit.description || "No description")}</p>
    <div class="badge-row">
      ${categories.map((cat) => `<span class="badge badge-muted">${esc(cat)}</span>`).join("")}
      ${installed ? `<span class="badge badge-success">Installed</span>` : ""}
    </div>
    <div class="mod-foot">
      <span class="muted small">${formatCount(hit.downloads)} downloads · ${formatCount(hit.follows)} follows</span>
      <span class="muted small">${state.disc.tab === "pack" ? "pack" : "mod"}</span>
    </div>
  </article>`;
}

/* ============================================================================
   Filters drawer
   ========================================================================== */
function populateFiltersUi() {
  const f = state.filters;
  const entry = activeEntry();

  if ($("fVersionOverride")) $("fVersionOverride").checked = f.versionOverride;
  if ($("fVersionValue")) {
    $("fVersionValue").textContent = f.versionOverride
      ? "Any Minecraft version"
      : entry && entry.versionId
        ? `Pinned to ${entry.versionId}`
        : "Any Minecraft version (no profile version)";
  }

  if ($("fLoaderOverride")) $("fLoaderOverride").checked = f.loaderOverride;
  if ($("fLoaderValue")) {
    $("fLoaderValue").textContent = f.loaderOverride
      ? f.loaders.length
        ? f.loaders.join(", ")
        : "Any loader"
      : entry && entry.loader && entry.loader !== "vanilla"
        ? `Pinned to ${entry.loader}`
        : "Vanilla only (no loader)";
  }

  const chips = $("fLoaderChips");
  if (chips) {
    chips.hidden = !f.loaderOverride;
    if (f.loaderOverride) {
      chips.innerHTML = LOADERS.map(
        (loader) =>
          `<button type="button" class="chip${f.loaders.includes(loader) ? " active" : ""}" data-loader-chip="${loader}">${esc(loader)}</button>`
      ).join("");
    }
  }

  if ($("fCategoryOverride")) $("fCategoryOverride").checked = f.categoryOverride;
  const categorySelect = $("fCategorySelect");
  if (categorySelect) {
    const list = f.categoryOverride ? CATEGORIES_FULL : CATEGORIES_ESSENTIAL;
    categorySelect.innerHTML =
      `<option value="">All ${f.categoryOverride ? "" : "essential "}categories</option>` +
      list.map((cat) => `<option value="${cat}"${f.category === cat ? " selected" : ""}>${esc(cat)}</option>`).join("");
  }
  if ($("fCategoryCustom")) {
    $("fCategoryCustom").hidden = !f.categoryOverride;
    $("fCategoryCustom").value = f.customCategory;
  }

  if ($("fEnvOverride")) $("fEnvOverride").checked = f.environmentOverride;
  if ($("fEnvSelect")) {
    const options = f.environmentOverride
      ? [
          ["client", "Client"],
          ["server", "Server"],
          ["", "Any environment"],
        ]
      : [["client", "Client"]];
    $("fEnvSelect").innerHTML = options
      .map(([value, label]) => `<option value="${value}"${f.environment === value ? " selected" : ""}>${label}</option>`)
      .join("");
  }

  if ($("fSortOverride")) $("fSortOverride").checked = f.sortOverride;
  if ($("fSortSelect")) {
    const options = f.sortOverride
      ? [
          ["downloads", "Downloads"],
          ["relevance", "Relevance"],
          ["follows", "Followers"],
          ["newest", "Newest"],
          ["updated", "Recently updated"],
        ]
      : [
          ["downloads", "Downloads"],
          ["relevance", "Relevance"],
        ];
    $("fSortSelect").innerHTML = options
      .map(([value, label]) => `<option value="${value}"${f.sort === value ? " selected" : ""}>${label}</option>`)
      .join("");
  }

  if ($("fLicenseOverride")) $("fLicenseOverride").checked = f.licenseOverride;
  if ($("fLicenseSelect")) {
    $("fLicenseSelect").hidden = !f.licenseOverride;
    $("fLicenseSelect").value = f.license;
  }
  if ($("fOpenSource")) $("fOpenSource").checked = f.openSource;

  if ($("eCompatible")) $("eCompatible").checked = f.essentials.compatible;
  if ($("eHideInstalled")) $("eHideInstalled").checked = f.essentials.hideInstalled;
  if ($("eHideLibraries")) $("eHideLibraries").checked = f.essentials.hideLibraries;
  if ($("eRecent")) $("eRecent").checked = f.essentials.recent;
}

function activeFilterCount() {
  const f = state.filters;
  let count = 0;
  if (f.versionOverride) count += 1;
  if (f.loaderOverride) count += 1;
  if (f.categoryOverride) count += 1;
  if (f.environmentOverride) count += 1;
  if (f.sortOverride) count += 1;
  if (f.licenseOverride) count += 1;
  if (!f.essentials.compatible) count += 1;
  if (f.essentials.hideLibraries) count += 1;
  if (f.essentials.recent) count += 1;
  return count;
}

function renderFilterChips() {
  const row = $("activeFilterChips");
  const count = $("filtersCount");
  if (count) {
    count.hidden = activeFilterCount() === 0;
    count.textContent = String(activeFilterCount());
  }
  if (!row) return;
  const f = state.filters;
  const entry = activeEntry();
  const chips = [];

  chips.push(
    `<button type="button" class="chip${f.versionOverride ? " active" : ""}" data-chip="versionOverride">${
      f.versionOverride ? "Any MC version" : entry && entry.versionId ? `MC ${esc(entry.versionId)}` : "Any MC version"
    }</button>`
  );
  if (state.disc.tab === "mod") {
    chips.push(
      `<button type="button" class="chip${f.loaderOverride ? " active" : ""}" data-chip="loaderOverride">${
        f.loaderOverride ? "Any loader" : entry && entry.loader ? esc(entry.loader) : "vanilla"
      }</button>`
    );
  }
  if (f.category || f.customCategory) {
    const label = f.customCategory || f.category;
    chips.push(`<button type="button" class="chip active" data-chip="category">${esc(label)} <span class="chip-x">×</span></button>`);
  }
  if (f.license) {
    chips.push(`<button type="button" class="chip active" data-chip="license">${esc(f.license)} <span class="chip-x">×</span></button>`);
  }
  row.innerHTML = chips.join("");
}

function openFilters() {
  populateFiltersUi();
  $("filtersDrawer").hidden = false;
  $("drawerScrim").hidden = false;
}

function closeFilters() {
  $("filtersDrawer").hidden = true;
  $("drawerScrim").hidden = true;
}

function readFilters() {
  const f = state.filters;
  f.versionOverride = !!$("fVersionOverride")?.checked;
  f.loaderOverride = !!$("fLoaderOverride")?.checked;
  f.categoryOverride = !!$("fCategoryOverride")?.checked;
  f.category = $("fCategorySelect")?.value || "";
  f.customCategory = $("fCategoryCustom")?.value || "";
  f.environmentOverride = !!$("fEnvOverride")?.checked;
  f.environment = $("fEnvSelect")?.value ?? "client";
  f.sortOverride = !!$("fSortOverride")?.checked;
  f.sort = $("fSortSelect")?.value || "downloads";
  f.licenseOverride = !!$("fLicenseOverride")?.checked;
  f.license = $("fLicenseSelect")?.value || "";
  f.openSource = !!$("fOpenSource")?.checked;
  f.essentials.compatible = !!$("eCompatible")?.checked;
  f.essentials.hideInstalled = !!$("eHideInstalled")?.checked;
  f.essentials.hideLibraries = !!$("eHideLibraries")?.checked;
  f.essentials.recent = !!$("eRecent")?.checked;
}

function resetFilters() {
  state.filters = {
    versionOverride: false,
    loaderOverride: false,
    loaders: [],
    category: "",
    customCategory: "",
    categoryOverride: false,
    environment: "client",
    environmentOverride: false,
    sort: "downloads",
    sortOverride: false,
    licenseOverride: false,
    license: "",
    openSource: false,
    essentials: { compatible: true, hideInstalled: true, hideLibraries: false, recent: false },
  };
  populateFiltersUi();
  renderFilterChips();
}

/* ============================================================================
   Item (mod / pack) details
   ========================================================================== */
function openItemModal(hit) {
  state.disc.selected = hit;
  const isPack = state.disc.tab === "pack";
  $("imIcon").src = hit.icon_url || "../../assets/logo.svg";
  $("imTitle").textContent = hit.title || "Unknown";
  $("imAuthor").textContent = `${isPack ? "Resource pack" : "Mod"} by ${hit.author || "unknown"}`;
  $("imDescription").textContent = hit.description || "No description available.";
  $("imStats").innerHTML = `
    <span class="badge">${formatCount(hit.downloads)} downloads</span>
    <span class="badge">${formatCount(hit.follows)} followers</span>
    ${(hit.categories || []).slice(0, 3).map((cat) => `<span class="badge badge-muted">${esc(cat)}</span>`).join("")}
    ${isHitInstalled(hit) ? `<span class="badge badge-success">Installed</span>` : ""}`;

  const profileSelect = $("imProfile");
  if (!profileNames().length) {
    profileSelect.innerHTML = `<option value="">Create a profile first</option>`;
    profileSelect.disabled = true;
  } else {
    profileSelect.disabled = false;
    profileSelect.innerHTML = profileOptions(state.activeProfile);
  }

  $("imAutoWrap").hidden = isPack;
  $("imDeps").hidden = isPack;
  $("imDeps").innerHTML = "";
  $("imStatus").textContent = "";
  $("imInstall").disabled = true;
  $("imInstall").textContent = isPack ? "Install pack" : "Install mod";
  $("imVersion").innerHTML = `<option>Loading…</option>`;
  showModal("itemModal");
  loadItemVersions();
}

async function loadItemVersions() {
  const hit = state.disc.selected;
  const profileName = $("imProfile")?.value;
  const entry = profileName ? state.registry[profileName] : null;
  if (!hit) return;

  const isPack = state.disc.tab === "pack";
  const installBtn = $("imInstall");
  installBtn.disabled = true;
  $("imVersion").innerHTML = `<option>Loading…</option>`;
  $("imDeps").hidden = true;

  const options = {
    gameVersion: entry ? entry.versionId : undefined,
    family: !isPack && entry && entry.loader && entry.loader !== "vanilla" ? entry.loader : undefined,
    allVersions: state.filters.versionOverride || !state.filters.essentials.compatible,
  };

  const versions = await call("Loading versions", () => bridge.modVersions(hit.project_id, options));
  if (!versions) {
    $("imVersion").innerHTML = `<option>Could not load versions</option>`;
    $("imStatus").textContent = "Version list failed to load. Toggle a filter override and retry.";
    return;
  }
  state.disc.versions = Array.isArray(versions) ? versions : [];
  const select = $("imVersion");
  select.innerHTML = "";
  if (!state.disc.versions.length) {
    select.innerHTML = `<option>No compatible versions</option>`;
    $("imStatus").textContent = isPack
      ? "No version of this pack matches the profile's game version."
      : "No version matches this profile's game version and loader. Try the loader/version override.";
    return;
  }
  const installedVersionId = hit.project_id ? state.installed.projectVersions.get(hit.project_id) : null;
  for (const version of state.disc.versions) {
    const file = (version.files || []).find((entryFile) => entryFile.primary) || (version.files || [])[0];
    if (!file) continue;
    const option = document.createElement("option");
    option.value = version.id;
    option.textContent = `${version.version_number || version.id} · ${file.filename}${
      version.id === installedVersionId ? " · installed" : ""
    }`;
    select.appendChild(option);
  }
  if (installedVersionId && state.disc.versions.some((version) => version.id === installedVersionId)) {
    select.value = installedVersionId;
  }
  updateInstallButtonState();
  if (!isPack) loadItemDeps();
}

function updateInstallButtonState() {
  const btn = $("imInstall");
  if (!btn) return;
  const hit = state.disc.selected;
  const profileName = $("imProfile")?.value;
  const versionId = $("imVersion")?.value;
  const isPack = state.disc.tab === "pack";
  if (!profileName || !versionId) {
    btn.disabled = true;
    btn.textContent = isPack ? "Install pack" : "Install mod";
    return;
  }
  if (isPack) {
    btn.disabled = false;
    btn.textContent = "Install pack";
    $("imStatus").textContent = `${$("imVersion").options.length} compatible version(s).`;
    return;
  }
  const installedVersionId = hit?.project_id ? state.installed.projectVersions.get(hit.project_id) : null;
  if (installedVersionId && installedVersionId === versionId) {
    btn.disabled = true;
    btn.textContent = "Installed";
    $("imStatus").textContent = "This version is already installed in the profile.";
  } else {
    btn.disabled = false;
    btn.textContent = installedVersionId ? "Update mod" : "Install mod";
    $("imStatus").textContent = installedVersionId
      ? "A different version is installed; installing will replace it."
      : `${$("imVersion").options.length} compatible version(s).`;
  }
}

async function loadItemDeps() {
  const hit = state.disc.selected;
  const profileName = $("imProfile")?.value;
  const versionId = $("imVersion")?.value;
  if (!hit || state.disc.tab === "pack" || !profileName || !versionId) return;
  updateInstallButtonState();

  const deps = await call("Checking dependencies", () => bridge.modDependencies(profileName, hit.project_id, versionId));
  const box = $("imDeps");
  if (!box) return;
  if (!deps || !deps.length) {
    box.hidden = true;
    box.innerHTML = "";
    return;
  }
  box.hidden = false;
  box.innerHTML = `
    <strong class="small">Required dependencies</strong>
    ${deps
      .map(
        (dep) => `
      <div class="dep-line">
        <span>${esc(dep.projectName || dep.projectId || "external file")}</span>
        ${
          dep.satisfied
            ? `<span class="dep-chip ok">already installed</span>`
            : dep.resolved
              ? `<span class="dep-chip ok">will install${dep.versionNumber ? ` ${esc(dep.versionNumber)}` : ""}</span>`
              : `<span class="dep-chip missing">${esc(dep.reason || "cannot resolve")}</span>`
        }
      </div>`
      )
      .join("")}`;
}

async function installSelectedItem() {
  const hit = state.disc.selected;
  const profileName = $("imProfile")?.value;
  const versionId = $("imVersion")?.value;
  const isPack = state.disc.tab === "pack";
  if (!hit || !profileName || !versionId) return;

  const button = $("imInstall");
  button.disabled = true;
  $("imStatus").textContent = "Installing…";

  if (isPack) {
    const result = await call("Installing resource pack", () => bridge.installPack(profileName, hit.project_id, versionId));
    if (result) {
      $("imStatus").textContent = `Installed ${result.filename} into ${profileName}.`;
      toast(`Resource pack installed to ${profileName}`, "ok");
    }
    button.disabled = false;
    return;
  }

  const result = await call("Installing mod", () =>
    bridge.installMod(profileName, hit.project_id, versionId, !!$("imAutoDeps")?.checked)
  );
  if (!result) {
    button.disabled = false;
    return;
  }

  const installedNames = (result.installed || []).map((mod) => mod.name).filter(Boolean);
  const shownNames = installedNames.slice(0, 4).join(", ");
  const extraNames = installedNames.length > 4 ? ` +${installedNames.length - 4} more` : "";
  const summary = [];
  if (installedNames.length) summary.push(`installed ${shownNames}${extraNames}`);
  else if (result.installed.length) summary.push(`installed ${result.installed.length}`);
  if (result.alreadyInstalled.length) summary.push(`${result.alreadyInstalled.length} already present`);
  if (result.replaced.length) summary.push(`replaced ${result.replaced.length} duplicate copy`);
  if (result.missing.length) summary.push(`${result.missing.length} unresolved dependency`);

  $("imStatus").textContent = summary.length ? `Done — ${summary.join(", ")}.` : "Nothing to install.";
  if (result.missing.length) {
    toast(`Installed, but ${result.missing.length} required dependency could not be resolved.`, "warn");
  } else {
    toast(
      installedNames.length
        ? `Installed ${shownNames}${extraNames} to ${profileName}`
        : `Nothing new to install for ${profileName}`,
      "ok"
    );
  }
  await loadInstalledForActive();
  updateInstallButtonState();
  if (state.disc.tab === "mod") await loadDiscover();
}

/* ============================================================================
   Profile settings modal
   ========================================================================== */
async function openProfileSettings(name) {
  const entry = state.registry[name];
  if (!entry) return;
  state.profileModal.name = name;
  state.profileModal.tree = null;
  state.profileModal.packs = [];

  $("pmTitle").textContent = name;
  $("pmSubtitle").textContent = `${loaderLabel(entry)}${entry.versionId ? ` · Minecraft ${entry.versionId}` : ""}${
    entry.source === "zip" ? " · legacy zip package" : ""
  }`;
  $("pmIcon").src = iconSrc(entry.icon);
  $("pmPathLabel").textContent = entry.path || "";

  const bounds = state.info?.memoryBounds || { min: 2048, max: 8192, step: 256, totalMb: 0, suggested: 4096 };
  const memory = entry.memoryMb || bounds.suggested;
  const range = $("pmMemory");
  range.min = String(bounds.min);
  range.max = String(bounds.max);
  range.step = String(bounds.step);
  range.value = String(Math.min(bounds.max, Math.max(bounds.min, memory)));
  updateMemoryUi();

  $("pmJavaPath").value = entry.javaPath || "";
  $("pmJvmArgs").value = entry.jvmArgs || "";
  $("pmModsSummary").innerHTML = "";
  $("pmModTree").innerHTML = "";
  $("pmMissingDeps").hidden = true;
  $("pmPackList").innerHTML = "";

  showModal("profileModal");
  await Promise.all([refreshProfileMods(name), refreshProfilePacks(name)]);
}

function updateMemoryUi() {
  const range = $("pmMemory");
  if (!range) return;
  const min = Number(range.min) || 2048;
  const max = Number(range.max) || 8192;
  const value = Number(range.value) || min;
  const percent = max > min ? ((value - min) / (max - min)) * 100 : 100;
  range.style.setProperty("--fill", `${percent}%`);
  if ($("pmMemoryPill")) $("pmMemoryPill").textContent = `${value} MiB`;
  if ($("pmMemoryMin")) $("pmMemoryMin").textContent = `${min} MiB`;
  if ($("pmMemoryMax")) $("pmMemoryMax").textContent = `${max} MiB`;
  if ($("pmMemoryHint")) {
    const total = state.info?.memoryBounds?.totalMb;
    $("pmMemoryHint").textContent = total
      ? `System RAM ${total} MiB. The upper bound is RAM − 1024 MiB, leaving room for the OS and off-heap game memory; the lower bound is ${min} MiB.`
      : `Heap must stay between ${min} MiB and system RAM − 1024 MiB.`;
  }
}

async function refreshProfileMods(name) {
  const tree = await call("Scanning installed mods", () => bridge.modTree(name));
  if (!tree) return;
  state.profileModal.tree = tree;

  const summary = $("pmModsSummary");
  if (summary) {
    summary.innerHTML = `
      <span class="badge">${tree.mods.length} mod${tree.mods.length === 1 ? "" : "s"}</span>
      <span class="badge badge-muted">${formatBytes(tree.totalSize)}</span>
      ${
        tree.missing.length
          ? `<span class="badge badge-warn">${tree.missing.length} missing dependenc${tree.missing.length === 1 ? "y" : "ies"}</span>`
          : `<span class="badge badge-success">dependencies satisfied</span>`
      }`;
  }
  renderTreeInto($("pmModTree"), tree, name);

  const missingBox = $("pmMissingDeps");
  if (missingBox) {
    if (tree.missing.length) {
      missingBox.hidden = false;
      missingBox.innerHTML = `<strong>Missing required dependencies</strong>${tree.missing
        .map((item) => `<div>${esc(item.mod)} needs <span class="mono">${esc(item.dependency)}</span></div>`)
        .join("")}`;
    } else {
      missingBox.hidden = true;
      missingBox.innerHTML = "";
    }
  }
}

async function refreshProfilePacks(name) {
  const result = await call("Scanning resource packs", () => bridge.listPacks(name));
  if (!result) return;
  state.profileModal.packs = result.packs || [];
  renderPacksInto($("pmPackList"), state.profileModal.packs);
}

function renderTreeInto(container, tree, profileName) {
  if (!container) return;
  container.innerHTML = "";
  if (!tree || !tree.mods.length) {
    container.innerHTML = `<p class="hint">No mods installed yet. Everything you install from Discover lands here.</p>`;
    return;
  }
  const roots = tree.roots && tree.roots.length ? tree.roots : tree.mods;
  const seen = new Set();
  for (const node of roots) container.appendChild(buildTreeNode(node, seen, profileName, 0));
}

function buildTreeNode(node, seen, profileName, depth) {
  const wrap = document.createElement("div");
  wrap.className = "tree-node";

  const missing = (node.dependencies || []).filter((dep) => dep.mandatory && !dep.satisfied).length;
  const row = document.createElement("div");
  row.className = "tree-row";
  row.innerHTML = `
    <span class="tree-dot${node.enabled === false ? " off" : missing ? " warn" : ""}"></span>
    <span class="tree-name" title="${esc(node.name)}">${esc(node.name)}</span>
    ${node.version ? `<span class="badge badge-muted mono">${esc(node.version)}</span>` : ""}
    ${node.loader ? `<span class="badge badge-muted">${esc(node.loader)}</span>` : ""}
    ${missing ? `<span class="badge badge-warn">${missing} missing</span>` : ""}
    <span class="tree-spacer"></span>
    <button class="icon-btn tiny" data-uninstall="${esc(node.filename)}" data-profile-name="${esc(profileName)}" title="Remove mod">✕</button>`;
  wrap.appendChild(row);

  const deps = (node.dependencies || []).filter((dep) => dep.mandatory);
  if (deps.length) {
    const depRow = document.createElement("div");
    depRow.className = "tree-deps";
    depRow.innerHTML = deps
      .map(
        (dep) =>
          `<span class="dep-chip ${dep.satisfied ? "ok" : "missing"}"${
            dep.embedded ? ' title="Bundled inside the parent jar"' : ""
          }>${dep.satisfied ? "✓" : "!"} ${esc(dep.id)}${
            dep.versionRange ? ` ${esc(dep.versionRange)}` : ""
          }${dep.embedded ? " (embedded)" : ""}</span>`
      )
      .join("");
    wrap.appendChild(depRow);
  }

  const children = node.children || [];
  if (children.length) {
    const childBox = document.createElement("div");
    childBox.className = "tree-children";
    for (const child of children) {
      if (seen.has(child.filename)) {
        const link = document.createElement("div");
        link.className = "hint mono small";
        link.textContent = `↺ ${child.name} (already shown above)`;
        childBox.appendChild(link);
        continue;
      }
      seen.add(child.filename);
      childBox.appendChild(buildTreeNode(child, seen, profileName, depth + 1));
    }
    wrap.appendChild(childBox);
  }
  return wrap;
}

function renderPacksInto(list, packs) {
  if (!list) return;
  if (!packs || !packs.length) {
    list.innerHTML = `<p class="hint">No resource packs installed yet — drop a .zip above or install one from Discover.</p>`;
    return;
  }
  list.innerHTML = packs
    .map(
      (pack) => `
      <div class="pack-row">
        <span class="pack-name">${esc(pack.name)}</span>
        <span class="pack-meta">${pack.kind === "zip" ? formatBytes(pack.size) : "folder"}${pack.format ? ` · format ${esc(pack.format)}` : ""}</span>
        <span class="tree-spacer"></span>
        <button class="icon-btn tiny" data-pack-delete="${esc(pack.name)}" title="Delete pack">✕</button>
      </div>`
    )
    .join("");
}

async function saveProfileSettings({ launch = false } = {}) {
  const name = state.profileModal.name;
  if (!name) return;
  const patch = {
    memoryMb: Number($("pmMemory").value),
    jvmArgs: $("pmJvmArgs").value.trim(),
    javaPath: $("pmJavaPath").value.trim(),
  };
  const result = await call("Saving profile settings", () => bridge.updateProfile(name, patch));
  if (!result) return;
  state.registry = result.registry;
  toast(`Saved settings for ${name}`, "ok");
  renderHome();
  renderLibrary();

  if (launch) {
    hideModal("profileModal");
    await launchProfile(name);
  } else {
    hideModal("profileModal");
  }
}

async function launchProfile(name) {
  if (!name) return;
  if (state.settings.username && $("playerName")) $("playerName").textContent = state.settings.username;
  const result = await call(`Launching ${name}`, () =>
    bridge.launchProfile(name, { username: state.settings.username })
  );
  if (result) toast(`${name} launching with ${result.memoryMb} MiB`, "ok");
}

async function deleteProfile(name) {
  if (!name) return;
  if (!confirm(`Delete "${name}" and its entire folder?\n\nThis removes mods, resource packs and the installed game files.`)) return;
  const registry = await call("Deleting profile", () => bridge.deleteProfile(name));
  if (!registry) return;
  hideModal("profileModal");
  await refreshRegistry();
  renderLibrary();
  renderHome();
  toast(`Deleted ${name}`, "ok");
}

async function importPacksFromPaths(paths) {
  const name = state.profileModal.name;
  if (!name || !paths.length) return;
  const result = await call("Importing resource packs", () => bridge.importPacks(name, paths));
  if (!result) return;
  state.profileModal.packs = result.packs;
  renderPacksInto($("pmPackList"), result.packs);
  toast(`Added ${result.added.length} resource pack(s)`, "ok");
}

/* ============================================================================
   Add profile modal
   ========================================================================== */
async function openAddProfile(presetLoader = null) {
  state.add.loader = presetLoader || "vanilla";
  state.add.versionType = "release";
  $$("#addLoaderToggle [data-loader]").forEach((btn) =>
    btn.classList.toggle("active", btn.dataset.loader === state.add.loader)
  );
  $("addVersionType").value = "release";
  $("addNameInput").value = "";
  $("addProgress").hidden = true;
  $("addProgressFill").style.width = "0%";
  $("addProgressLabel").textContent = "";
  $("addVersionSelect").innerHTML = `<option>Loading…</option>`;
  $("addLoaderVersionSelect").innerHTML = `<option>Loading…</option>`;
  $("addLoaderVersionField").hidden = state.add.loader === "vanilla";
  showModal("addProfileModal");
  await loadAddVersions();
}

async function loadAddVersions() {
  const type = state.add.versionType;
  const select = $("addVersionSelect");
  select.innerHTML = `<option>Loading…</option>`;
  const versions = await call("Loading Minecraft versions", () => bridge.listVersions([type]));
  if (!versions) {
    select.innerHTML = `<option>Could not load versions</option>`;
    return;
  }
  select.innerHTML = versions.map((version) => `<option value="${esc(version.id)}">${esc(version.id)}</option>`).join("");
  await loadAddLoaderVersions();
}

async function loadAddLoaderVersions() {
  const field = $("addLoaderVersionField");
  const select = $("addLoaderVersionSelect");
  if (state.add.loader === "vanilla") {
    field.hidden = true;
    return;
  }
  field.hidden = false;
  select.innerHTML = `<option>Loading…</option>`;
  const gameVersion = $("addVersionSelect").value;
  const versions = await call(`Loading ${state.add.loader} versions`, () =>
    bridge.listLoaderVersions(state.add.loader, gameVersion)
  );
  if (!versions) {
    select.innerHTML = `<option>Could not load loader versions</option>`;
    return;
  }
  if (!versions.length) {
    select.innerHTML = `<option>No versions available</option>`;
    return;
  }
  select.innerHTML = versions
    .map((item) => `<option value="${esc(item.version)}">${esc(item.version)}</option>`)
    .join("");
}

async function installNewProfile() {
  const gameVersion = $("addVersionSelect").value;
  const loader = state.add.loader;
  const loaderVersion = loader === "vanilla" ? null : $("addLoaderVersionSelect").value;
  const displayName = $("addNameInput").value.trim() || `${gameVersion}${loader === "vanilla" ? "" : ` (${loaderLabel({ loader })})`}`;

  if (!gameVersion) {
    toast("Pick a Minecraft version first.", "warn");
    return;
  }

  const button = $("addInstallBtn");
  button.disabled = true;
  $("addProgress").hidden = false;
  $("addProgressFill").style.width = "3%";
  $("addProgressLabel").textContent = "Starting installation…";

  const result = await call("Installing profile", () =>
    bridge.installVersion(gameVersion, loader, loaderVersion, displayName)
  );
  button.disabled = false;
  $("addProgress").hidden = true;

  if (!result) return;
  await refreshRegistry();
  state.activeProfile = result.installed;
  localStorage.setItem("cuboid.activeProfile", result.installed);
  renderProfileSwitchers();
  hideModal("addProfileModal");
  showView("library");
  toast(`Installed ${result.installed}`, "ok");
}

/* ============================================================================
   Progress / console events
   ========================================================================== */
function handleInstallProgress(info = {}) {
  const current = Number(info.current);
  const total = Number(info.total);
  const hasRatio = Number.isFinite(current) && Number.isFinite(total) && total > 0;
  const percent = hasRatio ? Math.max(2, Math.min(100, (current / total) * 100)) : null;
  const label =
    info.message ||
    info.label ||
    (hasRatio ? `${info.stage || "Installing"} ${current}/${total}` : `${info.stage || "Installing"}…`);

  if ($("addProgress") && !$("addProgress").hidden) {
    $("addProgressFill").style.width = `${percent === null ? 12 : percent}%`;
    $("addProgressLabel").textContent = label;
  }
}

function handleJdkProgress(info = {}) {
  const box = $("jdkProgress");
  if (!box) return;
  box.hidden = false;
  if (info.percent != null) $("jdkProgressFill").style.width = `${info.percent}%`;
  $("jdkProgressLabel").textContent =
    info.phase === "done"
      ? info.cached
        ? "Already installed."
        : "Installed and set as the default runtime."
      : info.phase === "extract"
        ? "Extracting…"
        : info.receivedBytes
          ? `${formatBytes(info.receivedBytes)} / ${formatBytes(info.totalBytes)}`
          : "Downloading…";
}

function handleUpdateProgress(info = {}) {
  if (!$("updateProgress")) return;
  $("updateProgress").textContent =
    info.phase === "install" ? "Applying the update…" : info.percent != null ? `Downloading update… ${info.percent}%` : "Working…";
}

/* ============================================================================
   Settings
   ========================================================================== */
function showSettingsTab(tab) {
  state.settingsTab = tab;
  $$(".settings-tab").forEach((node) => (node.hidden = true));
  const panel = $(`settingsTab-${tab}`);
  if (panel) panel.hidden = false;
  $$(".settings-nav-item").forEach((item) => item.classList.toggle("active", item.dataset.settingsTab === tab));

  if (tab === "profiles") loadSettingsProfile();
}

async function renderSettings() {
  const info = state.info;
  if ($("currentUserDirLabel")) $("currentUserDirLabel").textContent = info ? info.userDir : "Unknown";
  if ($("jvmInput")) $("jvmInput").value = state.registry.default_jvm || "";
  if ($("usernameInput")) $("usernameInput").value = state.settings.username || "Player";
  if ($("aboutName") && info) $("aboutName").textContent = info.app.name;
  if ($("aboutVersion") && info) $("aboutVersion").textContent = `Version ${info.app.version} (launcher build ${info.app.launcherVersion})`;
  if ($("aboutSystem") && info) {
    $("aboutSystem").textContent = `${info.platform}/${info.arch} · ${info.cpus} CPUs · ${info.totalMemoryMb} MiB RAM · ${info.versionsDir}`;
  }

  showSettingsTab(state.settingsTab || "general");
  await Promise.all([refreshInstalledJdks(), refreshCachingSettings()]);
}

async function refreshInstalledJdks() {
  const list = $("installedJdkList");
  if (!list) return;
  const jdks = await call("Reading installed JDKs", () => bridge.getInstalledJdks());
  if (!jdks) return;
  if (!jdks.length) {
    list.innerHTML = `<p class="hint">No launcher-managed JDKs yet. Download one above.</p>`;
    return;
  }
  list.innerHTML = jdks
    .map(
      (jdk) => `
      <div class="list-row">
        <div>
          <div><strong>Temurin ${esc(jdk.version)}</strong></div>
          <div class="mono">${esc(jdk.path)}</div>
        </div>
        <button class="btn btn-secondary btn-sm" data-use-jdk="${esc(jdk.path)}">Use</button>
      </div>`
    )
    .join("");
}

async function refreshCachingSettings() {
  let settings = null;
  try {
    settings = await bridge.getSettings();
  } catch (err) {
    return;
  }
  state.settings = { ...state.settings, ...settings };
  const caching = settings.caching || {};
  if ($("cacheCheckVersions")) $("cacheCheckVersions").checked = caching.checkVersions !== false;
  if ($("cacheVersionsTTL")) $("cacheVersionsTTL").value = caching.versionsTTLHours ?? 24;
  if ($("cacheModloaders")) $("cacheModloaders").checked = caching.modloaders !== false;
  if ($("cacheModloaderTTL")) $("cacheModloaderTTL").value = caching.modloaderTTLHours ?? 12;
  if ($("cacheLibraries")) $("cacheLibraries").checked = caching.libraries !== false;
  if ($("cacheAssets")) $("cacheAssets").checked = caching.assets !== false;
  await refreshCacheStats();
}

async function refreshCacheStats() {
  const stats = await call("Reading cache usage", () => bridge.getCacheStats());
  if (!stats) return;
  if ($("cacheLibrariesStat")) $("cacheLibrariesStat").textContent = `${formatBytes(stats.libraries.bytes)} · ${stats.libraries.files} files`;
  if ($("cacheAssetsStat")) $("cacheAssetsStat").textContent = `${formatBytes(stats.assets.bytes)} · ${stats.assets.files} files`;
  if ($("cacheTotalStat")) $("cacheTotalStat").textContent = `${formatBytes(stats.total.bytes)} · ${stats.total.files} files`;
}

async function saveCachingSettings() {
  const caching = {
    checkVersions: !!$("cacheCheckVersions")?.checked,
    versionsTTLHours: Number($("cacheVersionsTTL")?.value) || 24,
    modloaders: !!$("cacheModloaders")?.checked,
    modloaderTTLHours: Number($("cacheModloaderTTL")?.value) || 12,
    libraries: !!$("cacheLibraries")?.checked,
    assets: !!$("cacheAssets")?.checked,
  };
  state.settings = { ...state.settings, caching };
  await call("Saving caching settings", () => bridge.saveSettings({ caching }));
}

async function loadSettingsProfile() {
  const select = $("settingsProfileSelect");
  if (!select) return;
  if (!profileNames().length) {
    $("settingsModTree").innerHTML = `<p class="hint">No profiles installed.</p>`;
    $("settingsPackList").innerHTML = "";
    if ($("settingsModsSummary")) $("settingsModsSummary").innerHTML = "";
    return;
  }
  state.settingsProfile = select.value || state.activeProfile;
  const name = state.settingsProfile;
  if ($("settingsModsSummary")) $("settingsModsSummary").innerHTML = "";
  $("settingsModTree").innerHTML = `<p class="hint">Scanning…</p>`;
  $("settingsPackList").innerHTML = "";

  const [tree, packs] = await Promise.all([
    call("Scanning installed mods", () => bridge.modTree(name)),
    call("Scanning resource packs", () => bridge.listPacks(name)),
  ]);

  if (tree) {
    $("settingsModsSummary").innerHTML = `
      <span class="badge">${tree.mods.length} mods</span>
      <span class="badge badge-muted">${formatBytes(tree.totalSize)}</span>
      ${tree.missing.length ? `<span class="badge badge-warn">${tree.missing.length} missing</span>` : `<span class="badge badge-success">deps ok</span>`}`;
    renderTreeInto($("settingsModTree"), tree, name);
  }
  if (packs) renderPacksInto($("settingsPackList"), packs.packs);
}

/* ============================================================================
   Updates
   ========================================================================== */
async function renderUpdates() {
  const infoBox = $("updateInfo");
  if (!infoBox) return;
  infoBox.innerHTML = `<p class="muted">Checking for updates…</p>`;
  const result = await call("Checking for updates", () => bridge.checkForUpdate());
  if (!result) {
    infoBox.innerHTML = `<p class="muted">Update check failed.</p>`;
    return;
  }
  infoBox.innerHTML = `
    <div class="list-row"><span>Installed version</span><strong>${esc(result.local)}</strong></div>
    <div class="list-row"><span>Latest version</span><strong>${result.remote ?? "unknown"}</strong></div>
    <div class="list-row"><span>Status</span>${
      result.updateAvailable ? `<span class="badge badge-success">Update available</span>` : `<span class="badge">Up to date</span>`
    }</div>
    <p class="hint">${result.error ? esc(result.error) : `Install type detected as ${esc(result.installType || "unknown")}.`}</p>`;
  const install = $("installUpdateBtn");
  if (install) install.hidden = !result.updateAvailable;
}

/* ============================================================================
   UI wiring
   ========================================================================== */
function applyTheme(light) {
  document.body.classList.toggle("light", !!light);
}

function bindUi() {
  $$(".nav-item").forEach((item) => item.addEventListener("click", () => showView(item.dataset.view)));
  $$("[data-goto]").forEach((item) => item.addEventListener("click", () => showView(item.dataset.goto)));

  $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => hideModal(btn.dataset.close)));
  $$(".modal-backdrop").forEach((backdrop) => {
    backdrop.addEventListener("mousedown", (event) => {
      if (event.target === backdrop) hideModal(backdrop.id);
    });
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const openModal = $$(".modal-backdrop").find((node) => !node.hidden);
    if (openModal) {
      hideModal(openModal.id);
      return;
    }
    if (!$("filtersDrawer").hidden) closeFilters();
  });

  $("themeBtn")?.addEventListener("click", async () => {
    const light = !document.body.classList.contains("light");
    applyTheme(light);
    state.settings.theme = light ? "light" : "dark";
    await call("Saving theme", () => bridge.saveSettings({ theme: state.settings.theme }));
  });

  $("activeProfileSelect")?.addEventListener("change", (event) => setActiveProfile(event.target.value));

  // Home
  $("homePlayBtn")?.addEventListener("click", () => launchProfile(state.activeProfile));
  $("homeManageBtn")?.addEventListener("click", () => showView("library"));
  $("homeQuickProfiles")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-profile]");
    if (card) openProfileSettings(card.dataset.profile);
  });

  // Library
  $("addProfileBtn")?.addEventListener("click", () => openAddProfile());
  $("libraryEmptyAdd")?.addEventListener("click", () => openAddProfile());
  $("addZipBtn")?.addEventListener("click", () => {
    $("zipPathInput").value = "";
    $("zipNameInput").value = "";
    showModal("zipModal");
  });
  $("libraryGrid")?.addEventListener("click", (event) => {
    const kebab = event.target.closest("[data-kebab]");
    if (kebab) {
      openProfileSettings(kebab.dataset.kebab);
      return;
    }
    const play = event.target.closest("[data-play]");
    if (play) {
      setActiveProfile(play.dataset.play);
      launchProfile(play.dataset.play);
      return;
    }
    const card = event.target.closest(".profile-card");
    if (card) openProfileSettings(card.dataset.profile);
  });

  // Discover
  $$("[data-market]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.disc.tab = btn.dataset.market;
      state.disc.query = "";
      state.disc.hits = [];
      renderDiscover();
    })
  );

  let searchTimer = null;
  $("discoverSearch")?.addEventListener("input", (event) => {
    state.disc.query = event.target.value.trim();
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => loadDiscover(), 320);
  });

  $("discoverGrid")?.addEventListener("click", (event) => {
    const card = event.target.closest("[data-project]");
    if (!card) return;
    const hit = state.disc.hits.find((item) => item.project_id === card.dataset.project);
    if (hit) openItemModal(hit);
  });

  $("filtersBtn")?.addEventListener("click", openFilters);
  $("drawerScrim")?.addEventListener("click", closeFilters);
  $$("[data-close-drawer]").forEach((btn) => btn.addEventListener("click", closeFilters));
  $("filtersApply")?.addEventListener("click", () => {
    readFilters();
    closeFilters();
    renderFilterChips();
    loadDiscover();
  });
  $("filtersReset")?.addEventListener("click", () => {
    resetFilters();
    loadDiscover();
  });
  $("fLoaderChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-loader-chip]");
    if (!chip) return;
    const loader = chip.dataset.loaderChip;
    const set = new Set(state.filters.loaders);
    if (set.has(loader)) set.delete(loader);
    else set.add(loader);
    state.filters.loaders = Array.from(set);
    populateFiltersUi();
  });
  $("fCategorySelect")?.addEventListener("change", (event) => {
    state.filters.category = event.target.value;
  });
  $("fCategoryOverride")?.addEventListener("change", (event) => {
    state.filters.categoryOverride = event.target.checked;
    populateFiltersUi();
  });
  $("fVersionOverride")?.addEventListener("change", (event) => {
    state.filters.versionOverride = event.target.checked;
    populateFiltersUi();
  });
  $("fLoaderOverride")?.addEventListener("change", (event) => {
    state.filters.loaderOverride = event.target.checked;
    if (event.target.checked && !state.filters.loaders.length) {
      const entry = activeEntry();
      state.filters.loaders = entry && entry.loader && entry.loader !== "vanilla" ? [entry.loader] : [];
    }
    populateFiltersUi();
  });
  $("fEnvOverride")?.addEventListener("change", (event) => {
    state.filters.environmentOverride = event.target.checked;
    populateFiltersUi();
  });
  $("fSortOverride")?.addEventListener("change", (event) => {
    state.filters.sortOverride = event.target.checked;
    populateFiltersUi();
  });
  $("fLicenseOverride")?.addEventListener("change", (event) => {
    state.filters.licenseOverride = event.target.checked;
    populateFiltersUi();
  });
  $("activeFilterChips")?.addEventListener("click", (event) => {
    const chip = event.target.closest("[data-chip]");
    if (!chip) return;
    const key = chip.dataset.chip;
    if (key === "versionOverride") state.filters.versionOverride = false;
    if (key === "loaderOverride") {
      state.filters.loaderOverride = false;
      state.filters.loaders = [];
    }
    if (key === "category") {
      state.filters.category = "";
      state.filters.customCategory = "";
    }
    if (key === "license") state.filters.license = "";
    populateFiltersUi();
    renderFilterChips();
    loadDiscover();
  });

  // Item modal
  $("imProfile")?.addEventListener("change", () => loadItemVersions());
  $("imVersion")?.addEventListener("change", () => loadItemDeps());
  $("imInstall")?.addEventListener("click", installSelectedItem);

  // Profile modal
  $("pmMemory")?.addEventListener("input", updateMemoryUi);
  $("pmMemoryReset")?.addEventListener("click", () => {
    const bounds = state.info?.memoryBounds;
    if (!bounds) return;
    $("pmMemory").value = String(bounds.suggested);
    updateMemoryUi();
  });
  $("pmJavaBrowse")?.addEventListener("click", async () => {
    const file = await call("Choosing Java executable", () => bridge.chooseJavaFile());
    if (file) $("pmJavaPath").value = file;
  });
  $("pmSave")?.addEventListener("click", () => saveProfileSettings());
  $("pmLaunch")?.addEventListener("click", () => saveProfileSettings({ launch: true }));
  $("pmDelete")?.addEventListener("click", () => deleteProfile(state.profileModal.name));
  $("pmOpenFolder")?.addEventListener("click", () => call("Opening profile folder", () => bridge.openProfileFolder(state.profileModal.name)));
  $("pmOpenMods")?.addEventListener("click", () => call("Opening mods folder", () => bridge.openModsFolder(state.profileModal.name)));
  $("pmOpenPacks")?.addEventListener("click", () =>
    call("Opening resource packs folder", () => bridge.openResourcePacksFolder(state.profileModal.name))
  );
  $("pmRefreshMods")?.addEventListener("click", () => refreshProfileMods(state.profileModal.name));
  $("pmRefreshPacks")?.addEventListener("click", () => refreshProfilePacks(state.profileModal.name));
  $("pmModTree")?.addEventListener("click", handleUninstallClick);
  $("settingsModTree")?.addEventListener("click", handleUninstallClick);
  $("pmPackList")?.addEventListener("click", handlePackDelete);
  $("settingsPackList")?.addEventListener("click", handlePackDelete);

  const dropzone = $("pmDropzone");
  if (dropzone) {
    dropzone.addEventListener("click", async () => {
      const files = await call("Choosing resource packs", () =>
        bridge.selectFiles([{ name: "Resource packs", extensions: ["zip"] }])
      );
      if (files && files.length) importPacksFromPaths(files);
    });
    dropzone.addEventListener("dragover", (event) => {
      event.preventDefault();
      dropzone.classList.add("dragover");
    });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragover"));
    dropzone.addEventListener("drop", (event) => {
      event.preventDefault();
      dropzone.classList.remove("dragover");
      const paths = Array.from(event.dataTransfer.files || [])
        .map((file) => bridge.pathForFile(file))
        .filter(Boolean);
      if (paths.length) importPacksFromPaths(paths);
      else toast("Those files could not be read — use the file picker.", "warn");
    });
  }

  // Add profile modal
  $$("#addLoaderToggle [data-loader]").forEach((btn) =>
    btn.addEventListener("click", () => {
      state.add.loader = btn.dataset.loader;
      $$("#addLoaderToggle [data-loader]").forEach((item) => item.classList.toggle("active", item === btn));
      loadAddLoaderVersions();
    })
  );
  $("addVersionType")?.addEventListener("change", (event) => {
    state.add.versionType = event.target.value;
    loadAddVersions();
  });
  $("addVersionSelect")?.addEventListener("change", () => loadAddLoaderVersions());
  $("addInstallBtn")?.addEventListener("click", installNewProfile);

  // ZIP modal
  $("zipBrowseBtn")?.addEventListener("click", async () => {
    const file = await call("Choosing ZIP", () => bridge.chooseZip());
    if (file) $("zipPathInput").value = file;
  });
  $("zipInstallBtn")?.addEventListener("click", async () => {
    const zipPath = $("zipPathInput").value;
    const name = $("zipNameInput").value.trim();
    if (!zipPath || !name) {
      toast("Pick a ZIP and give the profile a name.", "warn");
      return;
    }
    const result = await call("Installing ZIP", () => bridge.installZip(zipPath, name));
    if (!result) return;
    await refreshRegistry();
    hideModal("zipModal");
    showView("library");
    toast(`Installed legacy package ${name}`, "warn");
  });

  // Settings nav + fields
  $$(".settings-nav-item").forEach((btn) =>
    btn.addEventListener("click", () => showSettingsTab(btn.dataset.settingsTab))
  );

  $("usernameInput")?.addEventListener("change", async (event) => {
    const username = event.target.value.trim() || "Player";
    event.target.value = username;
    state.settings.username = username;
    if ($("playerName")) $("playerName").textContent = username;
    await call("Saving username", () => bridge.saveSettings({ username }));
  });

  $("openUserDirBtn")?.addEventListener("click", () => call("Opening launcher folder", () => bridge.openUserDir()));
  $("migrateBrowseBtn")?.addEventListener("click", async () => {
    const dir = await call("Choosing directory", () => bridge.chooseDirectory());
    if (dir) $("migrateDirInput").value = dir;
  });
  $("migrateStartBtn")?.addEventListener("click", async () => {
    const dir = $("migrateDirInput").value;
    if (!dir) {
      toast("Choose an empty destination folder first.", "warn");
      return;
    }
    if (!confirm(`Copy every profile and cache into:\n${dir}\n\nCuboid must be restarted afterwards. Continue?`)) return;
    $("migrateStatus").textContent = "Migrating…";
    const result = await call("Migrating", () => bridge.migrateUserDir(dir));
    if (result) $("migrateStatus").textContent = `Migrated to ${result.newDir}. Restart Cuboid.`;
  });

  $("jvmBrowseBtn")?.addEventListener("click", async () => {
    const file = await call("Choosing Java executable", () => bridge.chooseJavaFile());
    if (file) $("jvmInput").value = file;
  });
  $("setJvmBtn")?.addEventListener("click", async () => {
    const path = $("jvmInput").value.trim();
    if (!path) {
      toast("Java path is empty.", "warn");
      return;
    }
    const registry = await call("Saving Java path", () => bridge.setDefaultJvm(path));
    if (registry) {
      state.registry = registry;
      toast("Default Java runtime updated", "ok");
      renderHome();
    }
  });
  $("testJvmBtn")?.addEventListener("click", async () => {
    const path = $("jvmInput").value.trim();
    if (!path) {
      toast("Java path is empty.", "warn");
      return;
    }
    const result = await call("Testing Java", () => bridge.testJava(path));
    if (result) $("jvmTestResult").textContent = result.ok ? result.output.split("\n")[0] : `Failed: ${result.output}`;
  });
  $("openJavaFolderBtn")?.addEventListener("click", () => {
    const path = $("jvmInput").value.trim();
    if (path) bridge.openJavaFolder(path);
  });
  $("installJdkBtn")?.addEventListener("click", async () => {
    const version = $("jdkVersionSelect").value;
    const force = !!$("jdkForceReinstall").checked;
    $("jdkProgress").hidden = false;
    $("jdkProgressFill").style.width = "2%";
    $("jdkProgressLabel").textContent = "Contacting Adoptium…";
    const result = await call("Installing JDK", () => bridge.installJdk(version, force));
    if (result) {
      $("jvmInput").value = result.binaryPath;
      state.registry.default_jvm = result.binaryPath;
      toast(
        result.substituted
          ? `Installed Temurin ${result.feature} (no Java ${version} build was available)`
          : `Installed Temurin ${result.feature}`,
        "ok"
      );
      await refreshInstalledJdks();
      renderHome();
    }
  });
  $("installedJdkList")?.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-use-jdk]");
    if (!button) return;
    const registry = await call("Saving Java path", () => bridge.setDefaultJvm(button.dataset.useJdk));
    if (registry) {
      state.registry = registry;
      $("jvmInput").value = button.dataset.useJdk;
      toast("Default Java runtime updated", "ok");
    }
  });

  ["cacheCheckVersions", "cacheVersionsTTL", "cacheModloaders", "cacheModloaderTTL", "cacheLibraries", "cacheAssets"].forEach((id) => {
    $(id)?.addEventListener("change", saveCachingSettings);
  });
  $("clearLibrariesCacheBtn")?.addEventListener("click", async () => {
    await call("Clearing libraries", () => bridge.clearCache("libraries"));
    refreshCacheStats();
  });
  $("clearAssetsCacheBtn")?.addEventListener("click", async () => {
    await call("Clearing assets", () => bridge.clearCache("assets"));
    refreshCacheStats();
  });
  $("clearAllCacheBtn")?.addEventListener("click", async () => {
    if (!confirm("Clear every cache? Future installs re-download from scratch.")) return;
    await call("Clearing caches", () => bridge.clearCache("all"));
    refreshCacheStats();
  });

  $("settingsProfileSelect")?.addEventListener("change", loadSettingsProfile);
  $("settingsOpenProfile")?.addEventListener("click", () =>
    call("Opening profile folder", () => bridge.openProfileFolder(state.settingsProfile))
  );
  $("settingsOpenMods")?.addEventListener("click", () =>
    call("Opening mods folder", () => bridge.openModsFolder(state.settingsProfile))
  );
  $("settingsOpenPacks")?.addEventListener("click", () =>
    call("Opening resource packs folder", () => bridge.openResourcePacksFolder(state.settingsProfile))
  );
  $("settingsProfileSettings")?.addEventListener("click", () => {
    if (state.settingsProfile) openProfileSettings(state.settingsProfile);
  });
  $("aboutHomepageBtn")?.addEventListener("click", () => call("Opening homepage", () => bridge.openHomepage()));

  // Updates
  $("checkUpdateBtn")?.addEventListener("click", renderUpdates);
  $("installUpdateBtn")?.addEventListener("click", async () => {
    const result = await call("Installing update", () => bridge.performUpdate());
    if (result) {
      toast(result.message || "Update started", "ok");
    }
  });
}

async function handleUninstallClick(event) {
  const button = event.target.closest("[data-uninstall]");
  if (!button) return;
  const filename = button.dataset.uninstall;
  const profileName = button.dataset.profileName || state.profileModal.name;
  if (!profileName) return;
  if (!confirm(`Remove ${filename} from ${profileName}?`)) return;
  const result = await call("Removing mod", () => bridge.uninstallMod(profileName, filename));
  if (!result) return;
  toast(`Removed ${filename}`, "ok");
  if (state.profileModal.name === profileName) await refreshProfileMods(profileName);
  if (state.settingsProfile === profileName) await loadSettingsProfile();
  await loadInstalledForActive();
}

async function handlePackDelete(event) {
  const button = event.target.closest("[data-pack-delete]");
  if (!button) return;
  const name = button.dataset.packDelete;
  const inSettings = event.currentTarget && event.currentTarget.id === "settingsPackList";
  const profileName = inSettings ? state.settingsProfile : state.profileModal.name || state.settingsProfile;
  if (!profileName) return;
  if (!confirm(`Delete resource pack "${name}"?`)) return;
  const result = await call("Deleting resource pack", () => bridge.deletePack(profileName, name));
  if (!result) return;
  toast(`Deleted ${name}`, "ok");
  if (state.profileModal.name === profileName) renderPacksInto($("pmPackList"), result.packs);
  if (state.settingsProfile === profileName) renderPacksInto($("settingsPackList"), result.packs);
}

/* ============================================================================
   Start
   ========================================================================== */
window.addEventListener("error", (event) => {
  if (event && event.message) showError(event.message, "Renderer error");
});
window.addEventListener("unhandledrejection", (event) => {
  const reason = event.reason;
  showError(reason && reason.message ? reason.message : String(reason || "Unknown error"), "Unexpected error");
});

if (window.api) {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
