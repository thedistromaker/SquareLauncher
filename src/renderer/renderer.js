"use strict";

// ============================================================================
// State Management
// ============================================================================
const state = {
  registry: {},
  currentView: "home",
  selectedProfile: null,
  recentProfile: null,
  mods: {
    query: "",
    family: "fabric",
    requestId: 0,
    selectedProject: null,
    selectedVersions: [],
  },
  settings: {
    username: "Player",
    jvmPath: null,
    theme: "dark",
  },
};

// ============================================================================
// Utility Functions
// ============================================================================
const el = (id) => document.getElementById(id);

function log(text) {
  const out = el("logOutput");
  if (out) {
    out.textContent += text;
    out.scrollTop = out.scrollHeight;
  }
  console.log(text);
}

function showView(viewName) {
  document.querySelectorAll(".view").forEach(v => v.hidden = true);
  const view = el(viewName + "View");
  if (view) view.hidden = false;
  
  document.querySelectorAll(".nav-item").forEach(item => {
    item.classList.remove("active");
  });
  document.querySelector(`[data-view="${viewName}"]`)?.classList.add("active");
  
  state.currentView = viewName;
  
  // Trigger view-specific initialization
  if (viewName === "home") initHomeView();
  else if (viewName === "profiles") initProfilesView();
  else if (viewName === "mods") initModsView();
  else if (viewName === "settings") initSettingsView();
  else if (viewName === "updates") initUpdatesView();
}

function showModal(id) { el(id).hidden = false; }
function hideModal(id) { el(id).hidden = true; }

function formatBytes(bytes) {
  if (bytes === 0) return "0 B";
  const k = 1024;
  const sizes = ["B", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return Math.round(bytes / Math.pow(k, i) * 100) / 100 + " " + sizes[i];
}

// ============================================================================
// Modal Handling
// ============================================================================
document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => hideModal(btn.dataset.close));
});

// ============================================================================
// Theme Toggle
// ============================================================================
el("themeBtn")?.addEventListener("click", () => {
  document.body.classList.toggle("light");
  state.settings.theme = document.body.classList.contains("light") ? "light" : "dark";
  window.api?.saveSettings?.(state.settings);
});

// ============================================================================
// Logging Integration
// ============================================================================
el("clearLogBtn")?.addEventListener("click", () => {
  const out = el("logOutput");
  if (out) out.textContent = "";
});

if (window.api?.onLogLine) {
  window.api.onLogLine((text) => log(text));
}

if (window.api?.onInstallProgress) {
  window.api.onInstallProgress((info = {}) => {
    const progress = el("mojangProgress");
    const fill = el("mojangProgressFill");
    const label = el("mojangProgressLabel");
    if (!progress || !fill || !label) return;
    progress.hidden = false;
    const current = Number(info.current);
    const total = Number(info.total);
    const hasRatio = Number.isFinite(current) && Number.isFinite(total) && total > 0;
    const percent = hasRatio ? Math.max(0, Math.min(100, (current / total) * 100)) : null;
    fill.style.width = `${percent === null ? 8 : percent}%`;
    label.textContent = info.message || (hasRatio
      ? `${info.stage || "Installing"}: ${current}/${total}`
      : (info.label || info.stage || "Installing..."));
  });
}

// ============================================================================
// Sidebar Navigation
// ============================================================================
document.querySelectorAll(".nav-item").forEach((btn) => {
  btn.addEventListener("click", () => {
    const view = btn.dataset.view;
    if (view) showView(view);
  });
});

// ============================================================================
// HOME VIEW
// ============================================================================
async function initHomeView() {
  try {
    state.registry = await window.api.scanRegistry();
    const profiles = Object.entries(state.registry)
      .filter(([k]) => k !== "default_jvm")
      .map(([name, data]) => ({ name, data }));
    
    if ((!state.recentProfile || !profiles.some(p => p.name === state.recentProfile)) && profiles.length > 0) {
      state.recentProfile = profiles[0].name;
    }
  } catch (err) {
    log(`Error loading profiles: ${err.message}\n`);
  }
}

el("playBtn")?.addEventListener("click", async () => {
  const profileName = state.recentProfile;
  
  if (!profileName || !state.registry[profileName]) {
    log("Error: No profile selected.\n");
    return;
  }
  
  state.recentProfile = profileName;
  const profile = state.registry[profileName];
  
  try {
    log(`Launching ${profileName}...\n`);
    await window.api.launchProfile(profileName, {
      username: state.settings.username,
      jvmPath: state.settings.jvmPath || profile.default_jvm,
    });
  } catch (err) {
    log(`Launch error: ${err.message}\n`);
  }
});

// ============================================================================
// PROFILES VIEW
// ============================================================================
async function initProfilesView() {
  const grid = el("profilesGrid");
  const empty = el("profilesEmpty");
  
  if (!grid) return;
  
  try {
    state.registry = await window.api.scanRegistry();
    const profiles = Object.entries(state.registry)
      .filter(([k]) => k !== "default_jvm")
      .map(([name, data]) => ({ name, data }));
    
    grid.innerHTML = "";
    empty.hidden = profiles.length > 0;
    
    profiles.forEach(({ name, data }) => {
      const card = document.createElement("div");
      card.className = "profile-card";
      
      const icon = document.createElement("div");
      icon.className = "profile-icon";
      if (data.icon) {
        const img = document.createElement("img");
        img.src = `file://${data.icon}`;
        icon.appendChild(img);
      } else {
        icon.textContent = "▦";
      }
      
      const nameEl = document.createElement("div");
      nameEl.className = "profile-name";
      nameEl.textContent = name;
      
      const meta = document.createElement("div");
      meta.className = "profile-meta";
      const isVanilla = !data.loader || data.loader === "vanilla";
      meta.classList.toggle("vanilla", isVanilla);
      meta.textContent = isVanilla ? "Vanilla" : (data.loader.charAt(0).toUpperCase() + data.loader.slice(1));
      
      card.appendChild(icon);
      card.appendChild(nameEl);
      card.appendChild(meta);
      
      card.addEventListener("click", () => openProfileModal(name, data));
      grid.appendChild(card);
    });
  } catch (err) {
    log(`Error loading profiles: ${err.message}\n`);
  }
}

function openProfileModal(profileName, profileData) {
  const modal = el("profileModal");
  const title = el("profileModalTitle");
  const body = el("profileModalBody");
  
  if (!modal) return;
  
  title.textContent = profileName;
  body.innerHTML = `
    <div class="field">
      <label>Loader</label>
      <p class="${!profileData.loader || profileData.loader === "vanilla" ? "vanilla-label" : ""}">${profileData.loader ? profileData.loader.toUpperCase() : "Vanilla"}</p>
    </div>
    <div class="field">
      <label>Path</label>
      <p class="muted">${profileData.path}</p>
    </div>
    <div class="field">
      <label>Java Override (optional)</label>
      <input id="profileJvmInput" type="text" placeholder="Leave blank to use default" />
    </div>
  `;
  
  el("deleteProfileBtn").onclick = async () => {
    if (confirm(`Delete profile "${profileName}"?`)) {
      try {
        await window.api.deleteProfile(profileName);
        hideModal("profileModal");
        initProfilesView();
        log(`Deleted profile: ${profileName}\n`);
      } catch (err) {
        log(`Error deleting profile: ${err.message}\n`);
      }
    }
  };
  
  el("launchProfileBtn").onclick = async () => {
    const jvmOverride = document.getElementById("profileJvmInput")?.value;
    try {
      log(`Launching ${profileName}...\n`);
      await window.api.launchProfile(profileName, {
        username: state.settings.username,
        jvmPath: jvmOverride || state.settings.jvmPath,
      });
    } catch (err) {
      log(`Launch error: ${err.message}\n`);
    }
  };
  
  showModal("profileModal");
}

el("addProfileBtn")?.addEventListener("click", () => {
  showModal("mojangModal");
  initMojangModal();
});

// ============================================================================
// MODS VIEW
// ============================================================================
async function initModsView() {
  const grid = el("modsGrid");
  if (!grid) return;

  const query = el("modsSearch")?.value.trim() || "";
  const family = el("modsLoaderFilter")?.value || "all";
  state.mods.query = query;
  state.mods.family = family;
  const requestId = ++state.mods.requestId;
  grid.innerHTML = `<p class="muted">${query ? "Searching mods..." : "Loading trending mods..."}</p>`;
  
  try {
    const result = query
      ? await window.api.searchMods(query, family)
      : await window.api.trendingMods(family);
    if (requestId !== state.mods.requestId) return;
    const hits = Array.isArray(result) ? result : (Array.isArray(result?.hits) ? result.hits : []);

    if (hits.length === 0) {
      grid.innerHTML = "";
      const empty = el("modsEmpty");
      empty.querySelector("p").textContent = "No mods found for this loader.";
      empty.hidden = false;
      return;
    }
    
    grid.innerHTML = "";
    el("modsEmpty").hidden = true;
    
    hits.forEach((proj) => {
      const card = document.createElement("div");
      card.className = "mod-card";
      card.title = "Open mod details";
      
      const thumb = document.createElement("img");
      thumb.className = "mod-thumb";
      thumb.src = proj.icon_url || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect fill='%23333'/%3E%3C/svg%3E";
      thumb.onerror = () => thumb.style.display = "none";
      
      const name = document.createElement("div");
      name.className = "mod-name";
      name.textContent = proj.title || "Unknown";
      
      const desc = document.createElement("div");
      desc.className = "mod-desc";
      desc.textContent = proj.description || "No description";
      
      const meta = document.createElement("div");
      meta.className = "mod-meta";
      meta.innerHTML = `
        <span>${proj.downloads || 0} downloads</span>
      `;
      
      card.appendChild(thumb);
      card.appendChild(name);
      card.appendChild(desc);
      card.appendChild(meta);
      card.addEventListener("click", () => openModModal(proj));
      grid.appendChild(card);
    });
  } catch (err) {
    grid.innerHTML = "";
    const empty = el("modsEmpty");
    empty.querySelector("p").textContent = "Mods could not be loaded.";
    empty.hidden = false;
    log(`Error loading mods: ${err.message}\n`);
  }
}

let modsSearchTimer = null;
el("modsSearch")?.addEventListener("input", () => {
  clearTimeout(modsSearchTimer);
  modsSearchTimer = setTimeout(() => initModsView(), 300);
});
el("modsLoaderFilter")?.addEventListener("change", () => initModsView());

function profileEntries() {
  return Object.entries(state.registry)
    .filter(([name, data]) => name !== "default_jvm" && data && data.path)
    .map(([name, data]) => ({ name, data }));
}

async function openModModal(project) {
  state.mods.selectedProject = project;
  const profileSelect = el("modProfileSelect");
  const versionSelect = el("modVersionSelect");
  const installButton = el("modInstallBtn");
  el("modModalTitle").textContent = project.title || "Mod details";
  el("modModalDescription").textContent = project.description || "No description available.";
  el("modModalStats").textContent = `${Number(project.downloads || 0).toLocaleString()} downloads`;
  const icon = el("modModalIcon");
  icon.src = project.icon_url || "";
  icon.alt = project.title || "";
  profileSelect.innerHTML = "";
  profileEntries().forEach(({ name, data }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name} (${data.loader || "vanilla"}${data.versionId ? ` ${data.versionId}` : ""})`;
    profileSelect.appendChild(option);
  });
  if (!profileSelect.options.length) {
    versionSelect.innerHTML = "<option>Install a profile first</option>";
    installButton.disabled = true;
    el("modInstallStatus").textContent = "Create a profile before installing mods.";
  } else {
    const preferred = state.recentProfile && profileEntries().some((item) => item.name === state.recentProfile)
      ? state.recentProfile
      : profileSelect.options[0].value;
    profileSelect.value = preferred;
    await loadModVersions();
  }
  showModal("modModal");
}

async function loadModVersions() {
  const profileSelect = el("modProfileSelect");
  const versionSelect = el("modVersionSelect");
  const installButton = el("modInstallBtn");
  const profile = state.registry[profileSelect.value];
  const project = state.mods.selectedProject;
  installButton.disabled = true;
  versionSelect.innerHTML = "<option>Loading compatible versions...</option>";
  if (!profile || !project) return;
  try {
    const family = profile.loader && profile.loader !== "vanilla" ? profile.loader : "all";
    const versions = await window.api.modVersions(project.project_id, {
      gameVersion: profile.versionId,
      family,
    });
    state.mods.selectedVersions = Array.isArray(versions) ? versions : [];
    versionSelect.innerHTML = "";
    state.mods.selectedVersions.forEach((version) => {
      const file = (version.files || []).find((item) => item.primary) || (version.files || [])[0];
      if (!file) return;
      const option = document.createElement("option");
      option.value = version.id;
      option.textContent = `${version.version_number || version.id} · ${file.filename}`;
      versionSelect.appendChild(option);
    });
    installButton.disabled = !versionSelect.options.length;
    el("modInstallStatus").textContent = versionSelect.options.length
      ? `${versionSelect.options.length} compatible version(s) found.`
      : "No compatible versions found for this profile.";
  } catch (err) {
    versionSelect.innerHTML = "<option>Could not load versions</option>";
    el("modInstallStatus").textContent = err.message;
  }
}

el("modProfileSelect")?.addEventListener("change", loadModVersions);
el("modInstallBtn")?.addEventListener("click", async () => {
  const profileName = el("modProfileSelect")?.value;
  const versionId = el("modVersionSelect")?.value;
  const project = state.mods.selectedProject;
  if (!profileName || !versionId || !project) return;
  const button = el("modInstallBtn");
  button.disabled = true;
  el("modInstallStatus").textContent = "Downloading mod...";
  try {
    const result = await window.api.installMod(profileName, project.project_id, versionId);
    el("modInstallStatus").textContent = `Installed ${result.filename} to ${profileName}.`;
    log(`Installed ${result.filename} to ${profileName}/mods\n`);
  } catch (err) {
    el("modInstallStatus").textContent = `Install failed: ${err.message}`;
    button.disabled = false;
  }
});

// ============================================================================
// SETTINGS VIEW
// ============================================================================
async function initSettingsView() {
  const usernameInput = el("usernameInput");
  const jvmInput = el("jvmInput");
  
  try {
    state.registry = await window.api.scanRegistry();
    state.settings.jvmPath = state.registry.default_jvm || "";
    
    if (usernameInput) usernameInput.value = state.settings.username;
    if (jvmInput) jvmInput.value = state.settings.jvmPath;
  } catch (err) {
    log(`Error loading settings: ${err.message}\n`);
  }
}

el("setJvmBtn")?.addEventListener("click", async () => {
  const jvmPath = el("jvmInput")?.value;
  if (!jvmPath) {
    log("Error: Java path is empty.\n");
    return;
  }
  try {
    await window.api.setJavaRuntime(jvmPath);
    state.settings.jvmPath = jvmPath;
    log(`Java path set to: ${jvmPath}\n`);
  } catch (err) {
    log(`Error setting Java: ${err.message}\n`);
  }
});

el("testJvmBtn")?.addEventListener("click", async () => {
  const jvmPath = el("jvmInput")?.value;
  if (!jvmPath) {
    log("Error: Java path is empty.\n");
    return;
  }
  try {
    const version = await window.api.testJavaRuntime(jvmPath);
    log(`Java test successful: ${version}\n`);
  } catch (err) {
    log(`Java test failed: ${err.message}\n`);
  }
});

el("jvmBrowseBtn")?.addEventListener("click", async () => {
  try {
    const filePath = await window.api.chooseJavaFile();
    if (filePath) el("jvmInput").value = filePath;
  } catch (err) {
    log(`Error selecting Java: ${err.message}\n`);
  }
});

el("usernameInput")?.addEventListener("change", async (event) => {
  const username = event.target.value.trim() || "Player";
  state.settings.username = username;
  event.target.value = username;
  try {
    await window.api.saveSettings({ username });
  } catch (err) {
    log(`Error saving username: ${err.message}\n`);
  }
});

el("installJdkBtn")?.addEventListener("click", async () => {
  try {
    log("Starting OpenJDK 26 download...\n");
    await window.api.installJdk("26");
  } catch (err) {
    log(`JDK installation error: ${err.message}\n`);
  }
});

el("openUserDirBtn")?.addEventListener("click", async () => {
  try {
    await window.api.openUserDirectory();
  } catch (err) {
    log(`Error opening directory: ${err.message}\n`);
  }
});

el("addFromMojangBtn")?.addEventListener("click", () => {
  showModal("mojangModal");
  initMojangModal();
});

el("addZipBtn")?.addEventListener("click", () => {
  showModal("zipModal");
});

el("addForgeBtn")?.addEventListener("click", () => {
  showModal("mojangModal");
  initMojangModal("forge");
});

// ============================================================================
// UPDATES VIEW
// ============================================================================
async function initUpdatesView() {
  const infoDiv = el("updateInfo");
  const checkBtn = el("checkUpdateBtn");
  const installBtn = el("installUpdateBtn");
  
  if (!infoDiv) return;
  
  try {
    const updateInfo = await window.api.checkForUpdate();
    
    infoDiv.innerHTML = `
      <p><strong>Current version:</strong> ${updateInfo.local}</p>
      <p><strong>Latest version:</strong> ${updateInfo.remote || "Unknown"}</p>
      <p>${updateInfo.updateAvailable ? "An update is available!" : "You are up to date."}</p>
    `;
    
    if (updateInfo.updateAvailable) {
      if (installBtn) {
        installBtn.hidden = false;
        installBtn.onclick = async () => {
          try {
            log("Installing update...\n");
            await window.api.performUpdate();
          } catch (err) {
            log(`Update error: ${err.message}\n`);
          }
        };
      }
    } else {
      if (checkBtn) checkBtn.hidden = false;
      if (installBtn) installBtn.hidden = true;
    }
  } catch (err) {
    infoDiv.innerHTML = `<p class="muted">Error checking updates: ${err.message}</p>`;
  }
}

el("checkUpdateBtn")?.addEventListener("click", () => initUpdatesView());

// ============================================================================
// MOJANG MODAL (Fetch from Mojang)
// ============================================================================
let mojangState = { loader: "vanilla", versionType: "release" };
let mojangEventsBound = false;

async function initMojangModal(presetLoader = null) {
  const loaderToggle = el("loaderToggle");
  const versionTypeSelect = el("versionTypeSelect");
  const versionSelect = el("versionSelect");
  const loaderVersionField = el("loaderVersionField");
  const loaderVersionSelect = el("loaderVersionSelect");
  
  if (presetLoader) {
    mojangState.loader = presetLoader;
    document.querySelectorAll("[data-loader]").forEach(btn => {
      btn.classList.toggle("selected", btn.dataset.loader === presetLoader);
    });
  }
  async function loadVersions() {
    const type = mojangState.versionType;
    versionSelect.innerHTML = '<option>Loading...</option>';
    try {
      const versions = await window.api.listVersions(type);
      versionSelect.innerHTML = "";
      versions.forEach((v) => {
        const opt = document.createElement("option");
        opt.value = v.id;
        opt.textContent = v.id;
        versionSelect.appendChild(opt);
      });
      await loadLoaderVersions();
    } catch (err) {
      log(`Error loading versions: ${err.message}\n`);
    }
  }

  async function loadLoaderVersions() {
    if (!loaderVersionField || !loaderVersionSelect || mojangState.loader === "vanilla") {
      if (loaderVersionField) loaderVersionField.hidden = true;
      return;
    }
    loaderVersionField.hidden = false;
    loaderVersionSelect.innerHTML = "<option>Loading...</option>";
    try {
      const versions = await window.api.listLoaderVersions(mojangState.loader, versionSelect.value);
      loaderVersionSelect.innerHTML = "";
      versions.forEach((item) => {
        const option = document.createElement("option");
        option.value = item.version;
        option.textContent = item.version;
        loaderVersionSelect.appendChild(option);
      });
      if (!versions.length) loaderVersionSelect.innerHTML = "<option>No versions available</option>";
    } catch (err) {
      loaderVersionSelect.innerHTML = "<option>Could not load versions</option>";
      log(`Error loading ${mojangState.loader} versions: ${err.message}\n`);
    }
  }

  if (!mojangEventsBound) {
    document.querySelectorAll("[data-loader]").forEach((btn) => {
      btn.addEventListener("click", () => {
        document.querySelectorAll("[data-loader]").forEach((b) => b.classList.remove("selected"));
        btn.classList.add("selected");
        mojangState.loader = btn.dataset.loader;
        loadLoaderVersions();
      });
    });
    versionTypeSelect?.addEventListener("change", (e) => {
      mojangState.versionType = e.target.value;
      loadVersions();
    });
    versionSelect?.addEventListener("change", loadLoaderVersions);
    mojangEventsBound = true;
  }
  
  await loadVersions();
}

el("mojangInstallBtn")?.addEventListener("click", async () => {
  const mcVersion = el("versionSelect")?.value;
  const displayName = el("mojangNameInput")?.value || mcVersion;
  const loader = mojangState.loader;
  const loaderVersion = loader !== "vanilla" ? el("loaderVersionSelect")?.value : null;
  
  if (!mcVersion) {
    log("Error: Select a version.\n");
    return;
  }
  
  try {
    log(`Installing ${displayName} (${loader})...\n`);
    el("mojangProgress").hidden = false;
    el("mojangProgressFill").style.width = "0%";
    el("mojangProgressLabel").textContent = "Starting installation...";
    const javaPath = el("jvmInput")?.value;
    const result = await window.api.installVersion(
      mcVersion,
      loader,
      loaderVersion,
      displayName,
      javaPath
    );
    log(`Successfully installed: ${displayName}\n`);
    el("mojangProgress").hidden = true;
    hideModal("mojangModal");
    initProfilesView();
  } catch (err) {
    log(`Installation error: ${err.message}\n`);
  }
});

// ============================================================================
// ZIP MODAL (Add from ZIP)
// ============================================================================
el("zipBrowseBtn")?.addEventListener("click", async () => {
  try {
    const filePath = await window.api.selectFile({ filters: [{ name: "ZIP", extensions: ["zip"] }] });
    if (filePath) {
      el("zipPathInput").value = filePath;
    }
  } catch (err) {
    log(`Error selecting file: ${err.message}\n`);
  }
});

el("zipInstallBtn")?.addEventListener("click", async () => {
  const zipPath = el("zipPathInput")?.value;
  const name = el("zipNameInput")?.value;
  
  if (!zipPath || !name) {
    log("Error: ZIP file and name are required.\n");
    return;
  }
  
  try {
    log(`Installing from ZIP: ${name}...\n`);
    await window.api.installFromZip(zipPath, name);
    log(`Successfully installed: ${name}\n`);
    hideModal("zipModal");
    initProfilesView();
  } catch (err) {
    log(`ZIP installation error: ${err.message}\n`);
  }
});

// ============================================================================
// Initialization
// ============================================================================
async function init() {
  // Load settings
  try {
    const saved = await window.api.loadSettings?.();
    if (saved) {
      state.settings = { ...state.settings, ...saved };
      if (state.settings.theme === "light") {
        document.body.classList.add("light");
      }
      if (state.settings.username) {
        const usernameInput = el("usernameInput");
        if (usernameInput) usernameInput.value = state.settings.username;
      }
    }
  } catch (err) {
    console.log("Could not load settings:", err);
  }
  
  // Start with home view
  showView("home");
  
  log("SquareLauncher 3.0 ready.\n");
}

// Wait for API to be ready
if (window.api) {
  init();
} else {
  window.addEventListener("DOMContentLoaded", init);
}
