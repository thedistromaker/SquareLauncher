import os
import json
import zipfile
import tarfile
import shutil
import threading
import queue
import subprocess
import sys
import urllib.request
from pathlib import Path
import tkinter as tk
from tkinter import ttk, filedialog, simpledialog, messagebox
from tkinter import scrolledtext

from PIL import Image, ImageTk
# from tkinterdnd2 import TkinterDnD
# B2: Removed TkinterDnD since it's problematic on macOS 26.x, ARM64.
# ----------------------------
# Paths
# ----------------------------
BASE_DIR = Path(__file__).resolve().parent
VERSIONS_DIR = BASE_DIR / "versions"
REGISTRY_FILE = BASE_DIR / "versions.json"

VERSIONS_DIR.mkdir(exist_ok=True)

log_queue = queue.Queue()


# ----------------------------
# Logging
# ----------------------------
def log(msg):
    log_queue.put(msg)


# ----------------------------
# System helpers
# ----------------------------
def open_folder(path: Path):
    if sys.platform == "win32":
        os.startfile(path)
    elif sys.platform == "darwin":
        subprocess.Popen(["open", str(path)])
    else:
        subprocess.Popen(["xdg-open", str(path)])


def test_java(java_path: str):
    try:
        result = subprocess.run(
            [java_path, "-version"],
            capture_output=True,
            text=True
        )
        return result.returncode == 0, result.stderr + result.stdout
    except Exception as e:
        return False, str(e)


# ----------------------------
# Registry Management
# ----------------------------
def load_registry():
    if REGISTRY_FILE.exists():
        try:
            return json.loads(REGISTRY_FILE.read_text(encoding="utf-8"))
        except Exception:
            return {}
    return {}


def save_registry(data):
    REGISTRY_FILE.write_text(json.dumps(data, indent=2), encoding="utf-8")


def scan_versions():
    registry = load_registry()

    # Isolate global keys from structural directory scan loops
    default_jvm = registry.get("default_jvm", "")

    cleaned_registry = {"default_jvm": default_jvm}
    for name, data in registry.items():
        if name != "default_jvm" and isinstance(data, dict) and "path" in data and Path(data["path"]).exists():
            cleaned_registry[name] = data

    # Scan for new folders dynamically
    for v in VERSIONS_DIR.iterdir():
        if v.is_dir() and (v / "start.py").exists():
            cleaned_registry.setdefault(v.name, {
                "path": str(v),
                "icon": str(v / "icon.png") if (v / "icon.png").exists() else None,
                "jvm": None
            })

    save_registry(cleaned_registry)
    return cleaned_registry


# ----------------------------
# Launcher Core Execution
# ----------------------------
process = None


def launch_version(name, registry, username, jvm_global):
    global process

    entry = registry.get(name)
    if not entry or not isinstance(entry, dict):
        return

    raw_path = Path(entry["path"]).resolve()
    if raw_path.is_file():
        path = raw_path.parent
        start = raw_path
    else:
        path = raw_path
        start = path / "start.py"

    if not start.exists():
        messagebox.showerror("Error", f"Could not find startup script at:\n{start}")
        return

    jvm = entry.get("jvm") or jvm_global

    if not jvm:
        messagebox.showwarning("JVM Missing", "Please set or install a default Java runtime path.")
        return

    raw_jvm_path = Path(jvm)
    if raw_jvm_path.is_absolute():
        jvm_path = raw_jvm_path.resolve()
    else:
        jvm_path = (path / jvm).resolve()

    if sys.platform == "win32" and not jvm_path.suffix:
        if jvm_path.with_suffix(".exe").exists():
            jvm_path = jvm_path.with_suffix(".exe")
        elif jvm_path.with_name("javaw.exe").exists():
            jvm_path = jvm_path.with_name("javaw.exe")

    if not jvm_path.exists():
        messagebox.showerror("JVM Not Found", f"Could not find Java at:\n{jvm_path}")
        return

    log(f"\nLaunching {name}\nJVM: {jvm_path}\n")

    env = os.environ.copy()
    env["USERNAME"] = username
    env["JVM"] = str(jvm_path)

    process = subprocess.Popen(
        [sys.executable, str(start), f"--jvm={jvm_path}"],
        cwd=str(path),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        env=env
    )

    def reader():
        for line in iter(process.stdout.readline, ""):
            log(line)
        process.wait()
        log(f"\n[Exit {process.returncode}]\n")

    threading.Thread(target=reader, daemon=True).start()


# ----------------------------
# ZIP Installation Engine
# ----------------------------
def install_zip(zip_path, name):
    zip_path = Path(zip_path)
    target = VERSIONS_DIR / name

    if target.exists():
        shutil.rmtree(target)

    target.mkdir(parents=True, exist_ok=True)

    with zipfile.ZipFile(zip_path, "r") as z:
        z.extractall(target)

    if not (target / "start.py").exists():
        raise Exception("Invalid package (missing start.py)")


# ----------------------------
# User Interface (Tkinter)
# ----------------------------
class Launcher(tk.Tk):

    def __init__(self):
        super().__init__()

        self.title("Square Launcher 1.2")
        self.geometry("1340x720")

        self.registry = scan_versions()
        self.selected = None

        self.dark = True
        self.icon_cache = {}

        # Load standard configured Java default parameters out of internal JSON structures
        initial_jvm = self.registry.get("default_jvm", "")
        self.jvm_global = tk.StringVar(value=initial_jvm)
        # No icon because this is default build, not Chrome.

        self.setup_theme()
        self.build_ui()
        self.refresh()

        self.after(100, self.update_logs)

    def setup_theme(self):
        self.style = ttk.Style()
        self.style.theme_use("clam")
        self.apply_theme()

    def apply_theme(self):
        if self.dark:
            self.bg = "#1e1e1e"
            self.fg = "#ffffff"
            self.card = "#2a2a2a"
            self.accent = "#3a3a3a"
        else:
            self.bg = "#f5f5f5"
            self.fg = "#000000"
            self.card = "#ffffff"
            self.accent = "#dddddd"

        self.configure(bg=self.bg)

        if hasattr(self, "canvas"):
            self.canvas.configure(bg=self.bg)

        if hasattr(self, "grid_frame"):
            self.grid_frame.configure(bg=self.bg)

        if hasattr(self, "log"):
            self.log.configure(bg=self.bg, fg=self.fg, insertbackground=self.fg)

    def toggle_theme(self):
        self.dark = not self.dark
        self.apply_theme()
        self.refresh()

    def build_ui(self):
        top = tk.Frame(self, bg=self.bg)
        top.pack(fill="x", padx=10, pady=5)

        tk.Label(top, text="Username:", bg=self.bg, fg=self.fg).pack(side="left")
        self.username = tk.StringVar(value="Player")
        tk.Entry(top, textvariable=self.username, width=12).pack(side="left", padx=5)

        tk.Label(top, text="Java:", bg=self.bg, fg=self.fg).pack(side="left")
        tk.Entry(top, textvariable=self.jvm_global, width=28).pack(side="left", padx=5)

        # Added Command Buttons
        tk.Button(top, text="Set Default Java", command=self.set_default_jvm).pack(side="left", padx=2)
        tk.Button(top, text="Install Java 26", command=self.download_jdk_26).pack(side="left", padx=2)
        
        tk.Button(top, text="Test Java", command=self.test_jvm).pack(side="left", padx=2)
        tk.Button(top, text="Open Java Folder", command=self.open_jvm_folder).pack(side="left", padx=2)
        tk.Button(top, text="Add install zip", command=self.add_zip).pack(side="left", padx=2)
        tk.Button(top, text="Delete", command=self.delete_version).pack(side="left", padx=2)
        tk.Button(top, text="Rename", command=self.rename_version).pack(side="left", padx=2)
        tk.Button(top, text="Theme", command=self.toggle_theme).pack(side="left", padx=2)

        body_frame = tk.Frame(self, bg=self.bg)
        body_frame.pack(fill="both", expand=True, padx=10, pady=5)

        self.scroll = ttk.Scrollbar(body_frame, orient="vertical")
        self.scroll.pack(side="right", fill="y")

        self.canvas = tk.Canvas(body_frame, highlightthickness=0, bg=self.bg, yscrollcommand=self.scroll.set)
        self.canvas.pack(side="left", fill="both", expand=True)
        self.scroll.config(command=self.canvas.yview)

        self.grid_frame = tk.Frame(self.canvas, bg=self.bg)
        self.canvas_window = self.canvas.create_window((0, 0), window=self.grid_frame, anchor="nw")

        self.grid_frame.bind(
            "<Configure>",
            lambda e: self.canvas.configure(scrollregion=self.canvas.bbox("all"))
        )
        self.canvas.bind(
            "<Configure>",
            lambda e: self.canvas.itemconfig(self.canvas_window, width=e.width)
        )

        self.canvas.bind_all("<MouseWheel>", self._on_mousewheel)
        self.canvas.bind_all("<Button-4>", self._on_mousewheel)
        self.canvas.bind_all("<Button-5>", self._on_mousewheel)

        self.log = scrolledtext.ScrolledText(self, height=10, bg=self.bg, fg=self.fg, insertbackground=self.fg)
        self.log.pack(fill="x", padx=10, pady=5)

    def _on_mousewheel(self, event):
        if event.num == 4:
            self.canvas.yview_scroll(-1, "units")
        elif event.num == 5:
            self.canvas.yview_scroll(1, "units")
        else:
            if sys.platform == 'darwin':
                self.canvas.yview_scroll(int(-1 * event.delta), "units")
            else:
                self.canvas.yview_scroll(int(-1 * (event.delta / 120)), "units")

    def set_default_jvm(self):
        path = self.jvm_global.get().strip()
        if not path:
            messagebox.showwarning("Warning", "The current Java path is blank.")
            return
        
        self.registry = load_registry()
        self.registry["default_jvm"] = path
        save_registry(self.registry)
        log(f"[System] Global Default JVM set to: {path}\n")
        messagebox.showinfo("Success", "Default Java configuration saved permanently!")

    def download_jdk_26(self):
        # Identify platform tracking links for OpenJDK 26 build binaries
        if sys.platform == "win32":
            url = "https://download.java.net/java/early_access/jdk26/1/GPL/openjdk-26-ea+1_windows-x64_bin.zip"
            archive_ext = ".zip"
        elif sys.platform == "darwin":
            url = "https://download.java.net/java/early_access/jdk26/1/GPL/openjdk-26-ea+1_macos-x64_bin.tar.gz"
            archive_ext = ".tar.gz"
        else:
            url = "https://download.java.net/java/early_access/jdk26/1/GPL/openjdk-26-ea+1_linux-x64_bin.tar.gz"
            archive_ext = ".tar.gz"

        dest_dir = BASE_DIR / "jdk-26"
        if dest_dir.exists():
            if not messagebox.askyesno("Verify Overwrite", "A 'jdk-26' directory already exists. Re-download and overwrite?"):
                return
            shutil.rmtree(dest_dir)

        log("[Download] Starting OpenJDK 26 retrieval task sequence...\n")
        
        def worker():
            archive_path = BASE_DIR / f"jdk26_download{archive_ext}"
            try:
                # Execution tasks inside thread loops
                urllib.request.urlretrieve(url, archive_path)
                log("[Download] Package archive downloaded successfully. Extracting assets...\n")
                
                temp_extract_path = BASE_DIR / "jdk_temp_extract"
                if temp_extract_path.exists():
                    shutil.rmtree(temp_extract_path)

                if archive_ext == ".zip":
                    with zipfile.ZipFile(archive_path, 'r') as zip_ref:
                        zip_ref.extractall(temp_extract_path)
                else:
                    with tarfile.open(archive_path, 'r:gz') as tar_ref:
                        tar_ref.extractall(temp_extract_path)

                # Locate the actual root folder wrapped inside early access archives
                subdirs = [d for d in temp_extract_path.iterdir() if d.is_dir()]
                if subdirs:
                    shutil.move(str(subdirs[0]), str(dest_dir))
                else:
                    shutil.move(str(temp_extract_path), str(dest_dir))

                if temp_extract_path.exists():
                    shutil.rmtree(temp_extract_path)
                if archive_path.exists():
                    archive_path.unlink()

                # Automatically configure executable locations across operating targets
                if sys.platform == "win32":
                    binary_path = dest_dir / "bin" / "java.exe"
                elif sys.platform == "darwin":
                    binary_path = dest_dir / "Contents" / "Home" / "bin" / "java"
                else:
                    binary_path = dest_dir / "bin" / "java"

                self.jvm_global.set(str(binary_path))
                log(f"[Download] Finished! Auto-configured runtime path pointer to: {binary_path}\n")
                messagebox.showinfo("Installation Complete", f"JDK 26 downloaded and extraction mapped to:\n{dest_dir}")

            except Exception as e:
                log(f"[Error] Failed downloading dependencies: {e}\n")
                messagebox.showerror("Installation Error", f"Failed to acquire production environment: {e}")
                if archive_path.exists():
                    archive_path.unlink()

        threading.Thread(target=worker, daemon=True).start()

    def test_jvm(self):
        path = self.jvm_global.get()
        if not path:
            messagebox.showwarning("Missing JVM", "Set JVM path first")
            return
        ok, out = test_java(path)
        if ok:
            messagebox.showinfo("JVM OK", out)
        else:
            messagebox.showerror("JVM Failed", out)

    def open_jvm_folder(self):
        path = self.jvm_global.get()
        if not path:
            return
        open_folder(Path(path).parent)

    def load_icon(self, path):
        if not path or not Path(path).exists():
            return None
        try:
            img = Image.open(path).resize((64, 64), Image.Resampling.LANCZOS)
            return ImageTk.PhotoImage(img)
        except Exception:
            return None

    def refresh(self):
        self.registry = scan_versions()

        for w in self.grid_frame.winfo_children():
            w.destroy()

        cols = 4
        for col_idx in range(cols):
            self.grid_frame.grid_columnconfigure(col_idx, weight=1)

        for i, (name, data) in enumerate(self.registry.items()):
            if name == "default_jvm":
                continue

            is_sel = (name == self.selected)
            bg = self.accent if is_sel else self.card

            card = tk.Frame(self.grid_frame, bg=bg, bd=3 if is_sel else 2, relief="ridge")
            card.grid(row=i // cols, column=i % cols, padx=10, pady=10, sticky="nsew")

            icon = self.load_icon(data.get("icon"))
            self.icon_cache[name] = icon

            if icon:
                lbl_icon = tk.Label(card, image=icon, bg=bg)
                lbl_icon.pack()
                lbl_icon.bind("<Button-1>", lambda e, n=name: self.select(n))

            lbl_txt = tk.Label(card, text=name, bg=bg, fg=self.fg)
            lbl_txt.pack()
            lbl_txt.bind("<Button-1>", lambda e, n=name: self.select(n))

            tk.Button(
                card,
                text="Launch",
                command=lambda n=name: launch_version(
                    n,
                    self.registry,
                    self.username.get(),
                    self.jvm_global.get()
                )
            ).pack(pady=5)

            card.bind("<Button-1>", lambda e, n=name: self.select(n))

    def select(self, name):
        self.selected = name
        self.refresh()

    def add_zip(self):
        path = filedialog.askopenfilename(filetypes=[("Zip Packages", "*.zip")])
        if not path:
            return

        name = simpledialog.askstring("Name", "Version name:")
        if not name or not name.strip():
            return

        try:
            install_zip(path, name.strip())
            self.refresh()
        except Exception as e:
            messagebox.showerror("Installation Error", str(e))

    def delete_version(self):
        if not self.selected:
            return
        if messagebox.askyesno("Confirm Delete", f"Delete version '{self.selected}'?"):
            target_dir = VERSIONS_DIR / self.selected
            if target_dir.exists():
                try:
                    shutil.rmtree(target_dir)
                except Exception as e:
                    messagebox.showerror("Error", f"Failed to delete directory:\n{e}")
                    return

            self.selected = None
            save_registry({})
            self.refresh()

    def rename_version(self):
        if not self.selected:
            return

        new = simpledialog.askstring("Rename", "New name:")
        if not new or not new.strip():
            return

        new = new.strip()
        old_dir = VERSIONS_DIR / self.selected
        new_dir = VERSIONS_DIR / new

        if new_dir.exists():
            messagebox.showerror("Error", "A version with that name already exists!")
            return

        try:
            old_dir.rename(new_dir)
        except Exception as e:
            messagebox.showerror("Error", f"Failed to rename directory:\n{e}")
            return

        self.selected = new
        save_registry({})
        self.refresh()

    def update_logs(self):
        while not log_queue.empty():
            self.log.insert(tk.END, log_queue.get())
            self.log.see(tk.END)
        self.after(100, self.update_logs)


# ----------------------------
if __name__ == "__main__":
    Launcher().mainloop()
