#!/bin/bash

if [ $EUID -ne 0 ]; then
	echo " -> ERR: This script must be run as root. Use sudo and enter your password at the prompt."
	exit 1
fi
echo " -> Downloading 1/3: Python 3.13.13..."
if [ -e "python.pkg" ]; then
	rm -rf python.pkg
fi
curl -LJ https://www.python.org/ftp/python/3.13.13/python-3.13.13-macos11.pkg -o python.pkg
if [ $? -ne 0 ]; then
        echo " -> ERR: Failed to download Python 3.13.13."
        exit 1
fi
echo " -> Installing 1/2: Python 3.13.13..."
installer -pkg python.pkg -target /
if [ $? -ne 0 ]; then
	echo " -> ERR: Failed to install Python 3.13.13."
	exit 1
fi
echo " -> Downloading 2/3: Java 26.0.1..."
ARCH=$(uname -m)
case $ARCH in
	x86_64)
		ar="x64"
		;;
	arm64)
		ar="aarch64"
		;;
	*)
		echo " -> ERR: Architecture not supported."
		exit 1
		;;
esac
if [ -e "jdk-26.dmg" ]; then
	rm -rf jdk-26.dmg
fi
curl -LJ https://download.oracle.com/java/26/latest/jdk-26_macos-${ar}_bin.dmg -o "jdk-26.dmg"
if [ $? -ne 0 ]; then
        echo " -> ERR: Failed to download JDK 26."
        exit 1
fi
echo " -> Installing 2/2: JDK 26..."
hdiutil attach jdk-26.dmg
if [ $? -ne 0 ]; then
        echo " -> ERR: Failed to attach JDK 26 dmg."
        exit 1
fi
installer -pkg "/Volumes/JDK 26.0.1/JDK 26.0.1.pkg" -target /
if [ $? -ne 0 ]; then
        echo " -> ERR: Failed to install JDK 26."
        exit 1
fi
hdiutil detach "/Volumes/JDK 26.0.1"
if [ $? -ne 0 ]; then
        echo " -> WARN: Failed to detach JDK 26 dmg volume, you must do it manually or let the reboot unmount it."
fi
echo " -> Downloading 3/3: Python modules..."
/Library/Frameworks/Python.framework/Versions/3.14/bin/python3 -m pip install -r requirements.txt
if [ $? -ne 0 ]; then
        echo " -> ERR: Failed to install required Python modules."
        exit 1
fi
echo " -> Configuring 1/2: SquareLauncher wrapper..."
cp -Lr SquareLauncher.app /Applications/
if [ $? -ne 0 ]; then
        echo " -> WARN: Failed to configure automated startup wrapper; you must do it manually."
fi
cp -L start.sh /usr/local/bin/start-squarelauncher.sh
chmod +x /usr/local/bin/start-squarelauncher.sh
echo " -> Configuring 2/2: SquareLauncher..."
mkdir ~/SquareLauncher
cp -Lf main.py ~/SquareLauncher/
cp -Lf start.sh ~/SquareLauncher/
chmod +x ~/SquareLauncher/start.sh
echo " -> Install finished!"
exit 0
