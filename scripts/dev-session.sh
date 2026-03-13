#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="flyshell@flyshell"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="${HOME}/.local/share/gnome-shell/extensions"
DEST_DIR="${DEST_ROOT}/${EXT_UUID}"

echo "==> Installing extension to ${DEST_DIR}"
mkdir -p "${DEST_DIR}"
rsync -a --delete \
    --exclude='.git/' \
    --exclude='.gitignore' \
    --exclude='README.md' \
    --exclude='__pycache__/' \
    "${SRC_DIR}/" "${DEST_DIR}/"

# Compile GSettings schemas if present
if [[ -d "${DEST_DIR}/schemas" ]]; then
    glib-compile-schemas "${DEST_DIR}/schemas"
    echo "==> Compiled schemas"
fi

# Read API key from host keyring before entering the isolated D-Bus session.
API_KEY=""
if command -v secret-tool >/dev/null 2>&1; then
    API_KEY="$(secret-tool lookup service flightaware-aeroapi account default 2>/dev/null || true)"
    if [[ -n "${API_KEY}" ]]; then
        echo "==> Retrieved API key from host keyring"
    else
        echo "==> warning: no API key found in host keyring (extension will need manual config)"
    fi
fi

echo "==> Launching nested GNOME Shell session (Wayland)..."
echo "    Close the nested window to end the session."

# GNOME 49+ replaced --nested with --devkit (requires mutter-devkit package).
GNOME_VERSION="$(gnome-shell --version | grep -oP '\d+' | head -1)"
if [[ "${GNOME_VERSION}" -ge 49 ]]; then
    NESTED_FLAG="--devkit"
else
    NESTED_FLAG="--nested"
fi
echo "==> Detected GNOME ${GNOME_VERSION}, using ${NESTED_FLAG}"

export FLYSHELL_API_KEY="${API_KEY}"

# Resolution for the nested Mutter/GNOME Shell window (WIDTHxHEIGHT[@SCALE])
export MUTTER_DEBUG_DUMMY_MODE_SPECS="${MUTTER_DEBUG_DUMMY_MODE_SPECS:-2560x1440@2}"

dbus-run-session -- bash -c '
    gnome-shell '"${NESTED_FLAG}"' --wayland &
    SHELL_PID=$!

    # Wait for the nested shell to be ready
    for i in {1..30}; do
        if gnome-extensions info "'"${EXT_UUID}"'" &>/dev/null; then
            break
        fi
        sleep 0.5
    done

    gnome-extensions enable "'"${EXT_UUID}"'" 2>/dev/null && \
        echo "==> Extension enabled in nested session" || \
        echo "==> warning: could not auto-enable extension"

    wait $SHELL_PID
'

echo "==> Nested session ended."
