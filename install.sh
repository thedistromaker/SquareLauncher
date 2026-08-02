#!/bin/bash
if [ ! $EUID -eq 0 ]; then
    echo "This script must be run as root. Please use sudo."
    exit 1
fi

echo "Checking and removing square-launcher if it exists..."
if [ ! $(apt-get remove square-launcher -qq -y > /dev/null) ]; then
    echo "Continuing..."
else
    echo "square-launcher removed successfully."
fi
echo "Checking dependencies..."
if ! command -v wget &> /dev/null; then
    echo "wget could not be found. Installing wget..."
    apt-get install wget -qq -y > /dev/null
fi
if ! command -v lsb_release &> /dev/null; then
    echo "lsb_release could not be found. Installing lsb-release..."
    apt-get install lsb-release -qq -y > /dev/null
fi
echo "Downloading latest Square Launcher..."
ARCH=$(uname -m)
DISTRO=$(lsb_release -is | tail -1f)
if [ -z "$DISTRO" ]; then
    DISTRO=$(cat /etc/os-release | grep ^ID= | cut -d= -f2 | tr -d '"')
fi
if [ -e square-launcher.deb ]; then
    rm square-launcher.deb
fi
if [ -e square-launcher.rpm ]; then
    rm square-launcher.rpm
fi
if [ -e square-launcher.AppImage ]; then
    rm square-launcher.AppImage
fi
case $DISTRO in
    Ubuntu|Debian|ubuntu|debian)
        if [ "$ARCH" = "x86_64" ]; then
            wget -q --show-progress -O square-launcher.deb https://github.com/thedistromaker/SquareLauncher/releases/latest/download/square-launcher_2.2.1_amd64.deb
        elif [ "$ARCH" = "aarch64" ]; then
            wget -q --show-progress -O square-launcher.deb https://github.com/thedistromaker/SquareLauncher/releases/latest/download/square-launcher_2.2.1_arm64.deb
        else
            echo "Unsupported architecture: $ARCH"
            exit 1
        fi
        echo "Installing Square Launcher..."
        apt-get install -qq -y ./square-launcher.deb > /dev/null
        ;;
    Fedora|CentOS|RHEL|Rocky|AlmaLinux|fedora|centos|rhel|rocky|almalinux)
        if [ "$ARCH" = "x86_64" ]; then
            wget -q --show-progress -O square-launcher.rpm https://github.com/thedistromaker/SquareLauncher/releases/latest/download/square-launcher-2.2.1.x86_64.rpm
        elif [ "$ARCH" = "aarch64" ]; then
            wget -q --show-progress -O square-launcher.rpm https://github.com/thedistromaker/SquareLauncher/releases/latest/download/square-launcher-2.2.1.aarch64.rpm
        else
            echo "Unsupported architecture: $ARCH"
            exit 1
        fi
        echo "Installing Square Launcher..."
        dnf install -y ./square-launcher.rpm > /dev/null
        ;;
    *)
        echo "WARN: Distro has no official packaging source yet, using AppImage instead."
        if [ "$ARCH" = "x86_64" ]; then
            wget -q --show-progress -O square-launcher.AppImage https://github.com/thedistromaker/SquareLauncher/releases/latest/download/Square.Launcher-2.2.1.AppImage
        elif [ "$ARCH" = "aarch64" ]; then
            wget -q --show-progress -O square-launcher.AppImage https://github.com/thedistromaker/SquareLauncher/releases/latest/download/Square.Launcher-2.2.1-arm64.AppImage
        else
            echo "Unsupported architecture: $ARCH"
            exit 1
        fi
        chmod +x square-launcher.AppImage
        echo "Square Launcher downloaded as AppImage. You can run it with ./square-launcher.AppImage"
        ;;
esac
echo "Installed!"
exit 0
