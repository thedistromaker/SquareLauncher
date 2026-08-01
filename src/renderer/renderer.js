"use strict";

const state = {
  registry: {},
  selected: null,
  session: null,
};

const settings = { theme: "dark", jdkVersion: "26", userDir: null };

const el = (id) => document.getElementById(id);

function showModal(id) { el(id).hidden = false; }
function hideModal(id) { el(id).hidden = true; }

document.querySelectorAll("[data-close]").forEach((btn) => {
  btn.addEventListener("click", () => hideModal(btn.dataset.close));
});

function appendLog(text) {
  const out = el("logOutput");
  if (!out) return;
  out.textContent += text;
  out.scrollTop = out.scrollHeight;
}
if (window.api && window.api.onLogLine) window.api.onLogLine(appendLog);

const clearLogBtn = el("clearLogBtn");
if (clearLogBtn) clearLogBtn.addEventListener("click", () => {
  const out = el("logOutput");
  if (out) out.textContent = "";
});

// ---------------------------------------------------------------------
// Theme
// ---------------------------------------------------------------------
const themeBtn = el("themeBtn");
if (themeBtn) themeBtn.addEventListener("click", () => {
  document.body.classList.toggle("light");
});

// ---------------------------------------------------------------------
// Registry / cards
// ---------------------------------------------------------------------
async function refresh() {
  state.registry = await window.api.scanRegistry();
  el("jvmInput").value = state.registry.default_jvm || "";
  renderCards();
}

// Log registry paths for debugging autodetect issues
async function logRegistryInfo() {
  try {
    if (window.api && window.api.getRegistryInfo) {
      const info = await window.api.getRegistryInfo();
      appendLog(`[Registry] versionsDir=${info.versionsDir} registryFile=${info.registryFile} userDir=${info.userDir}\n`);
    }
  } catch (e) {
    /* ignore */
  }
}

function loaderLabel(loader) {
  if (loader === "fabric") return "Fabric";
  if (loader === "quilt") return "Quilt";
  return "Vanilla";
}

function renderCards() {
  const grid = el("cardGrid");
  grid.innerHTML = "";
  const entries = Object.entries(state.registry).filter(([name]) => name !== "default_jvm");

  el("versionCount").textContent = `${entries.length} installed`;
  el("emptyState").hidden = entries.length > 0;

  for (const [name, data] of entries) {
    const card = document.createElement("div");
    card.className = "version-card" + (name === state.selected ? " selected" : "");
    card.dataset.name = name;

    const iconWrap = document.createElement("div");
    iconWrap.className = "icon-wrap";
    if (data.icon) {
      const img = document.createElement("img");
      img.src = `file://${data.icon}`;
      iconWrap.appendChild(img);
    } else {
      iconWrap.textContent = name.slice(0, 1).toUpperCase();
    }

    const nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = name;

    const tagEl = document.createElement("span");
    tagEl.className = "source-tag";
    tagEl.textContent = data.source === "microsoft" ? loaderLabel(data.loader) : "Zip package";

    const launchBtn = document.createElement("button");
    launchBtn.className = "btn btn-accent launch-btn";
    launchBtn.textContent = "Launch";
    launchBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      launch(name);
    });

    card.appendChild(iconWrap);
    card.appendChild(nameEl);
    card.appendChild(tagEl);
    card.appendChild(launchBtn);

    card.addEventListener("click", () => openVersionModal(name));

    grid.appendChild(card);
  }
}

function openVersionModal(name) {
  state.selected = name;
  renderCards();
  el("versionModalTitle").textContent = name;
  el("versionJvmInput").value = state.registry[name].jvm || "";
  showModal("versionModal");
}

el("launchVersionBtn").addEventListener("click", () => {
  hideModal("versionModal");
  launch(state.selected);
});

el("renameVersionBtn").addEventListener("click", async () => {
  const name = state.selected;
  const newName = prompt("New name:", name);
  if (!newName || !newName.trim() || newName === name) return;
  try {
    state.registry = await window.api.renameVersion(name, newName.trim());
    state.selected = newName.trim();
    renderCards();
    hideModal("versionModal");
  } catch (err) {
    alert(err.message);
  }
});

el("deleteVersionBtn").addEventListener("click", async () => {
  const name = state.selected;
  if (!confirm(`Delete "${name}"? This removes its files too.`)) return;
  state.registry = await window.api.deleteVersion(name);
  state.selected = null;
  renderCards();
  hideModal("versionModal");
});

async function launch(name) {
  try {
    await window.api.launch(name, el("usernameInput").value.trim() || "Player", el("jvmInput").value.trim());
  } catch (err) {
    appendLog(`\n[Error] ${err.message}\n`);
    alert(err.message);
  }
}

// ---------------------------------------------------------------------
// Java runtime controls
// ---------------------------------------------------------------------
el("jvmBrowseBtn").addEventListener("click", async () => {
  const p = await window.api.chooseJavaFile();
  if (p) el("jvmInput").value = p;
});

el("setJvmBtn").addEventListener("click", async () => {
  const path = el("jvmInput").value.trim();
  if (!path) return alert("The Java path is blank.");
  state.registry = await window.api.setDefaultJvm(path);
  appendLog(`[System] Default Java set to: ${path}\n`);
});

el("testJvmBtn").addEventListener("click", async () => {
  const path = el("jvmInput").value.trim();
  if (!path) return alert("Set a Java path first.");
  const { ok, output } = await window.api.testJava(path);
  alert(ok ? `Java OK:\n\n${output}` : `Java failed:\n\n${output}`);
});

function updateJdkProgress(info) {
  const row = el("jdkProgressRow");
  const fill = el("jdkProgressFill");
  const pct = el("jdkProgressPercent");
  const label = el("jdkProgressLabel");

  if (info.phase === "download") {
    row.hidden = false;
    label.textContent = `Downloading OpenJDK ${settings.jdkVersion || "26"}…`;
    if (info.percent === null || info.percent === undefined) {
      fill.style.width = "100%";
      pct.textContent = "…";
    } else {
      fill.style.width = `${info.percent}%`;
      pct.textContent = `${info.percent}%`;
    }
  } else if (info.phase === "extract") {
    row.hidden = false;
    label.textContent = `Extracting OpenJDK ${settings.jdkVersion || "26"}…`;
    fill.style.width = "100%";
    pct.textContent = "…";
  } else if (info.phase === "done") {
    label.textContent = "Done";
    fill.style.width = "100%";
    pct.textContent = "100%";
    setTimeout(() => {
      row.hidden = true;
    }, 1200);
  }
}
window.api.onJdkProgress(updateJdkProgress);

el("installJdkBtn").addEventListener("click", async () => {
  el("installJdkBtn").disabled = true;
  el("jdkProgressRow").hidden = false;
  el("jdkProgressFill").style.width = "0%";
  el("jdkProgressPercent").textContent = "0%";
  try {
    const binaryPath = await window.api.installJdk(settings.jdkVersion || "26");
    el("jvmInput").value = binaryPath;
    appendLog(`[Download] Auto-configured runtime path: ${binaryPath}\n`);
  } catch (err) {
    appendLog(`[Error] ${err.message}\n`);
    alert(err.message);
    el("jdkProgressRow").hidden = true;
  } finally {
    el("installJdkBtn").disabled = false;
  }
});

el("openUserDirBtn").addEventListener("click", async () => {
  try {
    await window.api.openUserDir();
  } catch (err) {
    appendLog(`[Error] ${err.message}\n`);
    alert(err.message);
  }
});

// ---------------------------------------------------------------------
// Config modal
// ---------------------------------------------------------------------
el("configBtn").addEventListener("click", async () => {
  try {
    const s = await window.api.getSettings();
    settings.theme = s.theme || settings.theme;
    settings.jdkVersion = s.jdkVersion || settings.jdkVersion;
    settings.userDir = s.userDir || settings.userDir;
  } catch (e) {
    /* ignore */
  }
  el("configUserDirInput").value = settings.userDir || "";
  el("configThemeSelect").value = settings.theme || "dark";
  el("configJdkSelect").value = settings.jdkVersion || "26";
  showModal("configModal");
});

el("configSaveBtn").addEventListener("click", async () => {
  const newDir = el("configUserDirInput").value.trim();
  const newTheme = el("configThemeSelect").value;
  const newJdk = el("configJdkSelect").value;

  try {
    const prevDir = settings.userDir;
    const updated = await window.api.setSettings({ theme: newTheme, jdkVersion: newJdk, userDir: newDir });
    settings.theme = updated.theme;
    settings.jdkVersion = updated.jdkVersion;
    settings.userDir = updated.userDir;

    // apply theme immediately
    if (settings.theme === "light") document.body.classList.add("light");
    else document.body.classList.remove("light");

    const installBtn = el("installJdkBtn");
    if (installBtn) installBtn.textContent = `Get OpenJDK ${settings.jdkVersion || "26"}`;

    // if userDir changed, attempt to write pointer (may require restart)
    if (newDir && newDir !== (prevDir || "")) {
      try {
        await window.api.setUserDir(newDir);
        appendLog(`[Settings] Home directory updated to: ${newDir} (restart may be required)\n`);
        alert("Home directory updated. You may need to restart the app for all changes to take effect.");
      } catch (err) {
        alert(`Failed to set home directory: ${err.message}`);
      }
    }

    hideModal("configModal");
  } catch (err) {
    alert(err.message || String(err));
  }
});

// ---------------------------------------------------------------------
// Zip install
// ---------------------------------------------------------------------
el("addZipBtn").addEventListener("click", () => {
  el("zipPathInput").value = "";
  el("zipNameInput").value = "";
  showModal("zipModal");
});

el("zipBrowseBtn").addEventListener("click", async () => {
  const p = await window.api.chooseZip();
  if (p) el("zipPathInput").value = p;
});

el("zipInstallBtn").addEventListener("click", async () => {
  const zipPath = el("zipPathInput").value.trim();
  const name = el("zipNameInput").value.trim();
  if (!zipPath || !name) return alert("Choose a zip file and give it a name.");
  try {
    state.registry = await window.api.installZip(zipPath, name);
    renderCards();
    hideModal("zipModal");
  } catch (err) {
    alert(err.message);
  }
});

// ---------------------------------------------------------------------
// Microsoft asset fetching
// ---------------------------------------------------------------------
let allVersions = [];
let selectedLoader = "vanilla";

el("profileToggle").addEventListener("click", (e) => {
  const btn = e.target.closest(".profile-option");
  if (!btn) return;
  document.querySelectorAll(".profile-option").forEach((b) => b.classList.remove("selected"));
  btn.classList.add("selected");
  selectedLoader = btn.dataset.loader;
});

el("addFromMicrosoftBtn").addEventListener("click", async () => {
  el("mojangNameInput").value = "";
  el("mojangProgress").hidden = true;
  selectedLoader = "vanilla";
  document.querySelectorAll(".profile-option").forEach((b) => b.classList.toggle("selected", b.dataset.loader === "vanilla"));
  updateCredentialNote();
  showModal("mojangModal");
  await loadVersionList();
});

function updateCredentialNote() {
  const note = el("credentialNote");
  if (state.session && state.session.ownsGame) {
    note.innerHTML = `<span class="muted">Signed in as <strong>${escapeHtml(
      state.session.profile.name
    )}</strong> — the generated start.py will use your real UUID and access token.</span>`;
  } else {
    note.innerHTML = `<span class="muted">Not signed in (or no license) — the generated start.py will fall back to an offline UUID, same as vanilla offline play.</span>`;
  }
}

el("versionTypeSelect").addEventListener("change", loadVersionList);

async function loadVersionList() {
  const select = el("versionSelect");
  select.innerHTML = "<option>Loading…</option>";
  const type = el("versionTypeSelect").value;
  allVersions = await window.api.listMojangVersions([type]);
  select.innerHTML = "";
  for (const v of allVersions) {
    const opt = document.createElement("option");
    opt.value = v.id;
    opt.textContent = v.id;
    select.appendChild(opt);
  }
}

window.api.onInstallProgress((info) => {
  el("mojangProgress").hidden = false;
  const fill = el("mojangProgressFill");
  const label = el("mojangProgressLabel");
  const stageLabels = {
    manifest: "Reading version manifest…",
    version_details: "Reading version details…",
    client_jar: "Downloading client…",
    libraries: `Downloading libraries (${info.current || 0}/${info.total || 0})`,
    natives: `Extracting natives (${info.current || 0}/${info.total || 0})`,
    asset_index: "Downloading asset index…",
    assets: `Downloading assets (${info.current || 0}/${info.total || 0})`,
    loader_resolve: `Resolving ${info.label || "loader"} version…`,
    loader_libraries: `Downloading ${info.label || "loader"} libraries (${info.current || 0}/${info.total || 0})`,
    writing_start_script: "Writing start.py…",
    done: "Done.",
  };
  label.textContent = stageLabels[info.stage] || info.stage;
  if (info.total) {
    fill.style.width = `${Math.min(100, Math.round(((info.current || 0) / info.total) * 100))}%`;
  } else if (info.stage === "done") {
    fill.style.width = "100%";
  }
});

el("mojangInstallBtn").addEventListener("click", async () => {
  const versionId = el("versionSelect").value;
  const displayName = el("mojangNameInput").value.trim();
  if (!versionId) return;
  el("mojangInstallBtn").disabled = true;
  try {
    state.registry = await window.api.installMojangVersion(versionId, displayName, selectedLoader);
    renderCards();
    hideModal("mojangModal");
  } catch (err) {
    appendLog(`[Error] ${err.message}\n`);
    alert(err.message);
  } finally {
    el("mojangInstallBtn").disabled = false;
  }
});

// ---------------------------------------------------------------------
// Microsoft login
// ---------------------------------------------------------------------
function renderAccountArea() {
  const area = el("accountArea");
  area.innerHTML = "";

  if (state.session && state.session.profile) {
    const chip = document.createElement("div");
    chip.className = "account-chip";

    const img = document.createElement("img");
    img.src = `https://mc-heads.net/avatar/${state.session.profile.id}/26`;
    chip.appendChild(img);

    const name = document.createElement("span");
    name.className = "name";
    name.textContent = state.session.profile.name;
    chip.appendChild(name);

    const badge = document.createElement("span");
    badge.className = "badge " + (state.session.ownsGame ? "badge-owned" : "badge-unowned");
    badge.textContent = state.session.ownsGame ? "Owned" : "No license";
    chip.appendChild(badge);

    area.appendChild(chip);

    const signOutBtn = document.createElement("button");
    signOutBtn.className = "btn btn-ghost";
    signOutBtn.textContent = "Sign out";
    signOutBtn.addEventListener("click", async () => {
      await window.api.signOut();
      state.session = null;
      renderAccountArea();
    });
    area.appendChild(signOutBtn);
  } else {
    const btn = document.createElement("button");
    btn.className = "btn btn-ghost";
    btn.id = "signInBtn";
    btn.textContent = "Sign in with Microsoft";
    btn.addEventListener("click", startSignIn);
    area.appendChild(btn);
  }
}

async function startSignIn() {
  el("signInBody").innerHTML = `<p class="muted">Requesting a sign-in code…</p>`;
  showModal("signInModal");
  try {
    const session = await window.api.signIn();
    state.session = session;
    renderAccountArea();
  } catch (err) {
    el("signInBody").innerHTML = `<p style="color:var(--danger)">${escapeHtml(err.message)}</p>`;
  }
}

window.api.onAuthProgress((info) => {
  const body = el("signInBody");
  switch (info.stage) {
    case "requesting_code":
      body.innerHTML = `<p class="muted">Requesting a sign-in code…</p>`;
      break;
    case "awaiting_user":
      body.innerHTML = `
        <p>Go to <a class="device-link" href="#">${escapeHtml(info.verificationUri)}</a> and enter this code:</p>
        <div class="device-code">${escapeHtml(info.userCode)}</div>
        <p class="muted">Waiting for you to finish signing in…</p>
      `;
      break;
    case "waiting":
      break; // keep showing the code
    case "xbox_live":
      body.innerHTML = `<p class="muted">Signed in. Contacting Xbox Live…</p>`;
      break;
    case "xsts":
      body.innerHTML = `<p class="muted">Authorizing session…</p>`;
      break;
    case "minecraft_login":
      body.innerHTML = `<p class="muted">Logging in to Minecraft services…</p>`;
      break;
    case "checking_ownership":
      body.innerHTML = `<p class="muted">Checking game ownership…</p>`;
      break;
    case "fetching_profile":
      body.innerHTML = `<p class="muted">Loading profile…</p>`;
      break;
    case "done":
      body.innerHTML = `<p style="color:var(--success)">Signed in.</p>`;
      setTimeout(() => hideModal("signInModal"), 700);
      updateCredentialNote();
      break;
    case "error":
      body.innerHTML = `<p style="color:var(--danger)">${escapeHtml(info.message)}</p>`;
      break;
  }
});

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str;
  return div.innerHTML;
}

// ---------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------
(async function init() {
  try {
    if (window.api && window.api.getSession) state.session = await window.api.getSession();
    renderAccountArea();
    await refresh();
    await logRegistryInfo();
    // update installer button label to reflect selected JDK
    const installBtn = el("installJdkBtn");
    if (installBtn) installBtn.textContent = `Get OpenJDK ${settings.jdkVersion || "26"}`;
  } catch (err) {
    appendLog(`[Init error] ${err && err.message ? err.message : String(err)}\n`);
    console.error("Renderer init error:", err);
  }
})();
