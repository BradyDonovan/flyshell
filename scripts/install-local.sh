#!/usr/bin/env bash
set -euo pipefail

EXT_UUID="flyshell@flyshell"
SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST_ROOT="${HOME}/.local/share/gnome-shell/extensions"
DEST_DIR="${DEST_ROOT}/${EXT_UUID}"
BACKUP_ROOT="${HOME}/.local/share/gnome-shell/extension-backups"

if [[ ! -f "${SRC_DIR}/metadata.json" ]]; then
    echo "error: metadata.json not found in source directory: ${SRC_DIR}" >&2
    exit 1
fi

mkdir -p "${DEST_ROOT}"
mkdir -p "${BACKUP_ROOT}"

if [[ -d "${DEST_DIR}" ]]; then
    ts="$(date +%Y%m%d-%H%M%S)"
    backup="${BACKUP_ROOT}/${EXT_UUID}.bak-${ts}"
    mv "${DEST_DIR}" "${backup}"
    echo "Backed up existing install to: ${backup}"
fi

mkdir -p "${DEST_DIR}"
rsync -a --delete \
    --exclude='.git/' \
    --exclude='.gitignore' \
    --exclude='README.md' \
    --exclude='__pycache__/' \
    "${SRC_DIR}/" "${DEST_DIR}/"
echo "Installed to: ${DEST_DIR}"

if [[ -d "${DEST_DIR}/schemas" ]]; then
    glib-compile-schemas "${DEST_DIR}/schemas"
    echo "Compiled schemas"
fi

if command -v gnome-extensions >/dev/null 2>&1; then
    # Reload in-place so JS/CSS changes apply without logout.
    gnome-extensions disable "${EXT_UUID}" >/dev/null 2>&1 || true

    if gnome-extensions enable "${EXT_UUID}"; then
        echo "Reloaded and enabled: ${EXT_UUID}"
        state_line="$(gnome-extensions info "${EXT_UUID}" | grep '^  State:' || true)"
        if [[ -n "${state_line}" ]]; then
            echo "${state_line}"
        fi
    else
        echo "warning: could not enable ${EXT_UUID} in current session" >&2
        echo "hint: retry with: gnome-extensions disable ${EXT_UUID} && gnome-extensions enable ${EXT_UUID}" >&2
        echo "hint: inspect errors with: journalctl --user -b --no-pager | grep -i '${EXT_UUID}' | tail -n 80" >&2
    fi
else
    echo "warning: gnome-extensions command not found" >&2
fi

echo "Done."
