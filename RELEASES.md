# qzu. releases

## Before using automatic deployment

The server currently keeps temporary conversations in RAM; a restart ends them. Review changes before merging to main. The deployment script checks tracked changes, requires a fast-forward, tests the candidate in a temporary directory, refuses changed runtime dependencies and verifies the running version after restart. It rolls back code, not database migrations. Back up SQLite before deploying schema changes. The first installation of the deployment script is manual. Enable the timer only after manually deploying and confirming the health endpoint, and after accepting automatic restart behavior.

On Oracle, after deployment and testing:
```sh
sudo install -m 644 deploy/qzu-deploy.service /etc/systemd/system/qzu-deploy.service
sudo install -m 644 deploy/qzu-deploy.timer /etc/systemd/system/qzu-deploy.timer
sudo systemctl daemon-reload
sudo systemctl enable --now qzu-deploy.timer
```
Disable with `sudo systemctl disable --now qzu-deploy.timer`. Review runs with `journalctl -u qzu-deploy.service`. The ubuntu account must be allowed to restart qzu via sudo without prompting.

## Android

Create the permanent signing key only once on the Mac, outside the repository:
```sh
mkdir -p "$HOME/.qzu-signing"
chmod 700 "$HOME/.qzu-signing"
"/Applications/Android Studio.app/Contents/jbr/Contents/Home/bin/keytool" -genkeypair -v -keystore "$HOME/.qzu-signing/release.jks" -alias qzu-release -keyalg RSA -keysize 3072 -validity 10000
```
Never overwrite or upload this key or share its password. Back it up securely. Existing debug-signed apps cannot update to this different signing certificate. Plan a new activation before switching those devices, because uninstalling can erase the registered device identity. Do not uninstall without understanding the consequences.

Build on the Mac with `npm run release:android`. The script prompts for the key password and verifies the APK signature. After testing, upload the signed release APK to the Oracle `~/ccWeb/data/releases/` folder using SCP. The server advertises only a matching version file if no explicit Android URL is configured. Install now opens the HTTPS download; the user must approve installation in Android. Keep the release folder writable only by the trusted deployment account. Native version numbers are derived from package.json.

## iOS

A personal/free signing team cannot provide general automatic distribution. Enroll in Apple Developer Program, create the App Store Connect app, and configure signing for the existing bundle identifier. Archive and upload with Xcode; distribute with TestFlight (builds expire) or the App Store after required review. Set QZU_IOS_UPDATE_URL to the official TestFlight or App Store link in the server .env. Do not put credentials or signing secrets in Git. Preserve the existing app identity where possible and verify the device account survives a signing-team transition. TestFlight auto-updates are controlled by the user's settings; the app does not silently install iOS binaries.

## Encryption scope

The experimental protocol uses signed ephemeral P-256 ECDH, manually verified safety codes and HKDF-derived per-message AES-GCM keys for direct text, images and audio. It is not an audited Signal/MLS protocol, does not offer a true ratchet or group encryption, and does not hide metadata. Group and support chats use transport encryption only. Chat keys currently live in memory and may be lost when the app process exits. Both devices must update and compare the full safety code through a trusted separate channel. Do not use it for high-risk communications before an independent review.
