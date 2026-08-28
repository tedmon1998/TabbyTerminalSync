#!/usr/bin/env bash

set -Eeuo pipefail

APP_NAME="Tabby Sync"
BUNDLE_ID="su.edro.tabby-sync"
PROJECT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd -P)"
INSTALL_DIR="/Applications"
TARGET_APP="${INSTALL_DIR}/${APP_NAME}.app"
SOURCE_APP=""
BUILD_IF_MISSING=1
LAUNCH_AFTER_INSTALL=1
BUILD_VERSION="${TABBY_BUILD_VERSION:-}"
WORK_DIR=""

usage() {
    cat <<'EOF'
Install Tabby Sync on macOS.

Usage:
  ./install-macos.sh [options]

Options:
  --app PATH         Install an existing "Tabby Sync.app" bundle.
  --no-build         Fail instead of building when no app bundle exists in dist/.
  --no-launch        Do not launch the app after installation.
  --version VERSION  Version used when the Git repository has no release tag.
  -h, --help         Show this help.

The script never deletes Tabby user settings. If an older application bundle is
installed, it is copied to a dated backup before it is replaced.
EOF
}

log() {
    printf '\n==> %s\n' "$*"
}

die() {
    printf '\nError: %s\n' "$*" >&2
    exit 1
}

cleanup() {
    if [[ -n "${WORK_DIR}" && -d "${WORK_DIR}" ]]; then
        rm -rf -- "${WORK_DIR}"
    fi
}
trap cleanup EXIT

while [[ $# -gt 0 ]]; do
    case "$1" in
        --app)
            [[ $# -ge 2 ]] || die "--app requires a path"
            SOURCE_APP="$2"
            shift 2
            ;;
        --no-build)
            BUILD_IF_MISSING=0
            shift
            ;;
        --no-launch)
            LAUNCH_AFTER_INSTALL=0
            shift
            ;;
        --version)
            [[ $# -ge 2 ]] || die "--version requires a value"
            BUILD_VERSION="$2"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            die "Unknown option: $1"
            ;;
    esac
done

[[ "$(uname -s)" == "Darwin" ]] || die "This installer must be run on macOS."

case "$(uname -m)" in
    arm64)
        BUILD_ARCH="arm64"
        ;;
    x86_64)
        BUILD_ARCH="x86_64"
        ;;
    *)
        die "Unsupported Mac architecture: $(uname -m)"
        ;;
esac

find_built_app() {
    local candidate
    local candidates=()

    if [[ "${BUILD_ARCH}" == "arm64" ]]; then
        candidates+=(
            "${PROJECT_DIR}/dist/mac-arm64/${APP_NAME}.app"
            "${PROJECT_DIR}/dist/mac/${APP_NAME}.app"
        )
    else
        candidates+=(
            "${PROJECT_DIR}/dist/mac/${APP_NAME}.app"
            "${PROJECT_DIR}/dist/mac-x64/${APP_NAME}.app"
        )
    fi

    for candidate in "${candidates[@]}"; do
        if [[ -d "${candidate}" ]] && app_supports_current_architecture "${candidate}"; then
            SOURCE_APP="${candidate}"
            return 0
        fi
    done

    return 1
}

app_supports_current_architecture() {
    local app_path="$1"
    local executable_path="${app_path}/Contents/MacOS/${APP_NAME}"
    local app_architectures

    [[ -f "${executable_path}" ]] || return 1
    app_architectures="$(lipo -archs "${executable_path}" 2>/dev/null || true)"
    [[ " ${app_architectures} " == *" ${BUILD_ARCH} "* ]]
}

ensure_yarn() {
    command -v node >/dev/null 2>&1 || die "Node.js 22.12 or newer is required."

    local node_supported
    node_supported="$(node -p 'const [major, minor] = process.versions.node.split(".").map(Number); major > 22 || (major === 22 && minor >= 12)')"
    [[ "${node_supported}" == "true" ]] || die "Node.js 22.12 or newer is required (found $(node --version))."

    if command -v yarn >/dev/null 2>&1; then
        return 0
    fi

    command -v corepack >/dev/null 2>&1 || die "Yarn is missing. Install Yarn or a Node.js distribution with Corepack."
    log "Enabling Yarn through Corepack"
    corepack enable
    command -v yarn >/dev/null 2>&1 || die "Corepack could not make Yarn available in PATH."
}

build_app() {
    ensure_yarn
    command -v git >/dev/null 2>&1 || die "Git is required to build the application."

    if [[ -z "${BUILD_VERSION}" ]] && ! git -C "${PROJECT_DIR}" describe --tags >/dev/null 2>&1; then
        BUILD_VERSION="1.0.0"
        log "No Git release tag found; using build version ${BUILD_VERSION}"
    fi

    if [[ -n "${BUILD_VERSION}" ]]; then
        export TABBY_BUILD_VERSION="${BUILD_VERSION}"
    fi
    export ARCH="${BUILD_ARCH}"

    log "Installing build dependencies"
    (
        cd "${PROJECT_DIR}"
        yarn install --frozen-lockfile --non-interactive
    )

    log "Building Tabby Sync"
    (
        cd "${PROJECT_DIR}"
        yarn run build
        node scripts/prepackage-plugins.mjs
        node scripts/build-macos.mjs
    )
}

if [[ -n "${SOURCE_APP}" ]]; then
    [[ -d "${SOURCE_APP}" ]] || die "Application bundle does not exist: ${SOURCE_APP}"
    SOURCE_APP="$(cd -- "$(dirname -- "${SOURCE_APP}")" && pwd -P)/$(basename -- "${SOURCE_APP}")"
elif ! find_built_app; then
    if [[ "${BUILD_IF_MISSING}" -eq 0 ]]; then
        die "No ${APP_NAME}.app was found in dist/. Build it first or pass --app PATH."
    fi
    build_app
    find_built_app || die "The build completed but ${APP_NAME}.app was not found in dist/."
fi

[[ -d "${SOURCE_APP}" ]] || die "Application bundle does not exist: ${SOURCE_APP}"
[[ -f "${SOURCE_APP}/Contents/Info.plist" ]] || die "Invalid application bundle: missing Contents/Info.plist"
[[ -x "${SOURCE_APP}/Contents/MacOS/${APP_NAME}" ]] || die "Invalid application bundle: missing executable"
app_supports_current_architecture "${SOURCE_APP}" || die "The application bundle does not support this Mac architecture (${BUILD_ARCH})."

ACTUAL_BUNDLE_ID="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleIdentifier' "${SOURCE_APP}/Contents/Info.plist" 2>/dev/null || true)"
[[ "${ACTUAL_BUNDLE_ID}" == "${BUNDLE_ID}" ]] || die "Unexpected bundle identifier: ${ACTUAL_BUNDLE_ID:-missing}"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/tabby-sync-install.XXXXXX")"
STAGED_APP="${WORK_DIR}/${APP_NAME}.app"

log "Validating application bundle"
ditto -- "${SOURCE_APP}" "${STAGED_APP}"
if ! codesign --verify --deep --strict "${STAGED_APP}" >/dev/null 2>&1; then
    log "Applying a local ad-hoc signature"
    codesign --force --deep --sign - "${STAGED_APP}"
    codesign --verify --deep --strict "${STAGED_APP}"
fi

SUDO=()
if [[ ! -w "${INSTALL_DIR}" ]]; then
    SUDO=(sudo)
fi

log "Closing the installed application"
osascript -e "tell application id \"${BUNDLE_ID}\" to quit" >/dev/null 2>&1 || true
for _ in {1..20}; do
    if ! pgrep -f "^${TARGET_APP}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
        break
    fi
    sleep 0.25
done
if pgrep -f "^${TARGET_APP}/Contents/MacOS/${APP_NAME}" >/dev/null 2>&1; then
    pkill -TERM -f "^${TARGET_APP}/Contents/MacOS/${APP_NAME}" || true
fi

BACKUP_APP=""
OLD_IN_PLACE="${INSTALL_DIR}/.${APP_NAME}.previous.$$"
if [[ -d "${TARGET_APP}" ]]; then
    BACKUP_ROOT="${HOME}/Library/Application Support/Tabby Sync Installer/Backups/$(date '+%Y-%m-%d_%H-%M-%S')"
    mkdir -p -- "${BACKUP_ROOT}"
    BACKUP_APP="${BACKUP_ROOT}/${APP_NAME}.app"
    log "Backing up the current application"
    ditto -- "${TARGET_APP}" "${BACKUP_APP}"
    "${SUDO[@]}" mv -- "${TARGET_APP}" "${OLD_IN_PLACE}"
fi

log "Installing ${APP_NAME} into ${INSTALL_DIR}"
if ! "${SUDO[@]}" ditto -- "${STAGED_APP}" "${TARGET_APP}"; then
    "${SUDO[@]}" rm -rf -- "${TARGET_APP}"
    if [[ -d "${OLD_IN_PLACE}" ]]; then
        "${SUDO[@]}" mv -- "${OLD_IN_PLACE}" "${TARGET_APP}"
    fi
    die "Installation failed; the previous application was restored."
fi

if [[ -d "${OLD_IN_PLACE}" ]]; then
    "${SUDO[@]}" rm -rf -- "${OLD_IN_PLACE}"
fi

codesign --verify --deep --strict "${TARGET_APP}"

if [[ "${LAUNCH_AFTER_INSTALL}" -eq 1 ]]; then
    log "Launching ${APP_NAME}"
    open -- "${TARGET_APP}"
fi

printf '\nInstalled: %s\n' "${TARGET_APP}"
if [[ -n "${BACKUP_APP}" ]]; then
    printf 'Previous app backup: %s\n' "${BACKUP_APP}"
fi
printf 'User profiles, passwords, themes, and settings were not modified.\n'
