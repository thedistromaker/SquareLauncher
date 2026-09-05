# Updating SquareLauncher
If your instance has pointed you here, good luck! It hasn't been able to self update.<br>
Find your install type and follow its steps.

## Linux/DEB
1. Go to the Releases section on this repository, go to latest (NOT pre-release unless you want to).
2. If your CPU is ARM, download the arm64 DEB. Or else download the AMD64 DEB. Not sure? Go to "I don't know my CPU's architecture!" and come back here.
3. Ensure all other SquareLauncher instances are closed (including 1.0/2.0).
4. Go to your Downloads ```~/Downloads``` and run: ```sudo apt install -y ./SquareLauncher-x.y.z-<arch>.deb``` (replace x.y.z with your actual version, or do ls to get the string, copy and paste)
5. It may prompt you for a password. Enter your own password that you set for your user.
6. Once the command finishes, open SquareLauncher.

## Linux/RPM
1. Go to the Releases section on this repository, go to latest (NOT pre-release unless you want to).
2. If your CPU is ARM, download the arm64 RPM. Or else download the AMD64 RPM. Not sure? Go to "I don't know my CPU's architecture!" and come back here.
3. Ensure all other SquareLauncher instances are closed (including 1.0/2.0).
4. Go to your Downloads ```~/Downloads``` and run: ```sudo dnf install -y ./SquareLauncher-x.y.z-<arch>.rpm``` (replace x.y.z with your actual version, or do ls to get the string, copy and paste)
5. It may prompt you for a password. Enter your own password that you set for your user.
6. Once the command finishes, open SquareLauncher.

## Linux/AppImage
1. Go to the Releases section on this repository, go to latest (NOT pre-release unless you want to).
2. If your CPU is ARM, download the arm64 AppImage. Or else download the AMD64 AppImage. Not sure? Go to "I don't know my CPU's architecture!" and come back here.
3. Ensure all other SquareLauncher instances are closed (including 1.0/2.0).
4. If you remember where your AppImage is located, copy from ```~/Downloads``` to the directory (eg ```cp -rLv ~/Downloads/squarelauncher-3.0.0-amd64.AppImage ~/SquareLauncher/program```)
5. Then, add the execute flag to it (eg ```chmod +x ~/SquareLauncher/program```)
6. Then open it how you did before.

## Windows
1. Go to the Releases section on this repository, go to latest (NOT pre-release unless you want to).
2. If your CPU is ARM, download the arm64 EXE. Or else download the AMD64 EXE. Not sure? Go to "I don't know my CPU's architecture!" and come back here.
3. Ensure all other SquareLauncher instances are closed (including 1.0/2.0).
4. Double click the installer EXE in your Downloads ```C:\Users\user\Downloads\```.
5. Then open it from Start.

## MacOS
1. Go to the Releases section on this repository, go to latest (NOT pre-release unless you want to).
2. If your CPU is ARM, download the arm64 DMG. Or else download the AMD64 DMG. Not sure? Go to "I don't know my CPU's architecture!" and come back here.
3. Ensure all other SquareLauncher instances are closed (including 1.0/2.0).
4. Open the DMG in your Downloads either using ```hdiutil attach SquareLauncher-3.0.0.dmg``` or double clicking in Finder.
5. Then copy over the SquareLauncher app to your Applications.
