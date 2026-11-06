#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

PROFILE="${NOTARY_PROFILE:-klat-notary}"
REPO="${RELEASE_REPO:-nandzz/klat}"
VERSION="$(node -p "require('./package.json').version")"
APP="dist-app/mac-arm64/Klat.app"
ZIP="dist-app/Klat-${VERSION}-arm64.zip"

if ! xcrun notarytool history --keychain-profile "$PROFILE" >/dev/null 2>&1; then
  echo "The notarytool profile \"$PROFILE\" does not work. Make it with:" >&2
  echo "  xcrun notarytool store-credentials $PROFILE --apple-id <apple-id> --team-id JM3HAUX538" >&2
  exit 1
fi

if [[ -n "$(git status --porcelain)" ]]; then
  echo "Commit your changes before a release." >&2
  exit 1
fi

npm test
npm run build
rm -rf dist-app
APPLE_KEYCHAIN_PROFILE="$PROFILE" npx electron-builder --mac --arm64 -c.mac.notarize=true

codesign --verify --deep --strict --verbose=2 "$APP"
xcrun stapler validate "$APP"
spctl --assess --type execute --verbose=2 "$APP"

SHA="$(shasum -a 256 "$ZIP" | awk '{print $1}')"

if [[ "${1:-}" == "--publish" ]]; then
  git tag -a "v${VERSION}" -m "Klat ${VERSION}"
  git push origin "v${VERSION}"
  gh release create "v${VERSION}" "$ZIP" --repo "$REPO" --title "Klat ${VERSION}" --notes "Signed with Developer ID and notarized by Apple. Install with \`brew install --cask nandzz/tap/klat\`."
fi

echo "Version: ${VERSION}"
echo "Zip:     ${ZIP}"
echo "SHA-256: ${SHA}"
