# Updating Cuboid manually

Cuboid 4.0 reports itself as newer than the legacy SquareLauncher feed, so the
in-app updater will normally say you're up to date. If you need to reinstall or
move to a newer build, use the release artefacts for your platform.

## Linux / DEB
1. Download the current `.deb` for your CPU (`amd64` for x64, `arm64` for ARM).
2. Run `sudo apt install -y ./Cuboid-{arch}.deb`.

## Linux / RPM
1. Download the current `.rpm` for your CPU.
2. Run `sudo dnf install -y ./Cuboid-{arch}.rpm` (or `sudo rpm -Uvh ./Cuboid-{arch}.rpm`).

## Linux / AppImage
1. Download the current `.AppImage` for your CPU.
2. Replace your existing AppImage, then `chmod +x Cuboid-{arch}.AppImage`.

## Windows / NSIS
1. Download the Windows `.exe` installer.
2. Run it and follow the prompts.

## macOS
1. Download the `.dmg`.
2. Drag Cuboid to Applications.
3. Approve it in System Settings — builds are unsigned.

## Migration from SquareLauncher 3.x

Cuboid reads the same `versions/` + `versions.json` layout. Point Cuboid at your
existing launcher directory (Settings → General → Migrate, or let it use the
default data folder) and every profile, mod and resource pack is picked up.
Microsoft sign-in sessions from 3.x are intentionally ignored and never loaded:
Cuboid runs offline-mode only.
