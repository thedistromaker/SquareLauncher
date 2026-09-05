# Updating SquareLauncher manually
If your install has led you here, it means one of two things:<br>
A: A bug in the code that couldn't detect the package origin (how it was installed)<br>
B: Your install was hard to detect (make an issue either way)
<br>C: You're using a Windows portable install/MacOS (unstable, still in priv testing)

Here's how to do it:

## Linux/DEB
1. Download the latest DEB file from the releases for your CPU architecture (arm64 for ARM, amd64 for Intel/AMD/other x64)
2. Go to your Downloads directory (usually ```~/Downloads```, if you chose a different directory go there)
3. Run ```sudo apt install -y ./SquareLauncher-{arch}.deb``` where ```{arch}``` is your architecture eg ```arm64``` or ```amd64```.
4. If it prompts for a password enter your user password.

## Linux/RPM
1. Download the latest RPM file from the releases for your CPU architecture (arm64 for ARM, amd64 for Intel/AMD/other x64)
2. Go to your Downloads directory (usually ```~/Downloads```, if you chose a different directory go there)
3. Run ```sudo dnf install -y ./SquareLauncher-{arch}.rpm ``` where ```{arch}``` is your architecture eg ```arm64``` or ```amd64```.
4. If it prompts for a password enter your user password.

## Linux/AppImage
1. Download the latest AppImage file from the releases for your CPU architecture (arm64 for ARM, amd64 for Intel/AMD/other x64)
2. Go to your Downloads directory (usually ```~/Downloads```, if you chose a different directory go there)
3. Copy it to where your current AppImage is and name it the same way (if using a launch script).
4. Run ```chmod +x SquareLauncher-{arch}.AppImage``` or whatever your file is named to make it executable.

## Windows/NSIS
1. Download the latest Windows EXE installer from the releases (amd64 only).
2. Go to your Downloads directory.
3. Double click to start the installer.

## Windows/ZIP
1. Download the latest Windows ZIP file (amd64 only).
2. Go to your Downloads directory.
3. Copy it to where you want to have your portable install.
4. Double click the .exe file to start.

## MacOS
1. Download the latest MacOS DMG file (all architectures excluding ppc/ppc64/ppc64le).
2. Go to your Downloads directory in Finder.
3. Double click on the SquareLauncher DMG.
4. Drag the app to the Applications folder.
5. Approve it in Settings as it is unsigned.
