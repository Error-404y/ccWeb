# qzu. releases

## Before using automatic deployment

The server keeps ordinary temporary conversations in RAM; a restart ends them. Starting in 0.9.3, mobile support conversations are an exception: support text and metadata are stored in the private server SQLite database until an admin deletes them, an admin-selected timer expires, or a participant invokes emergency/account erasure. They are transport-encrypted, not end-to-end encrypted, and SQLite/backups may retain historical copies. The Help screen informs users before opening support. Legacy command-line support remains temporary. Review changes before merging to main. The deployment script checks tracked changes, requires a fast-forward, tests the candidate in a temporary directory, refuses changed runtime dependencies and verifies the running version after restart. It rolls back code, not database migrations. Back up SQLite before deploying schema changes. The first installation of the deployment script is manual. Enable the timer only after manually deploying and confirming the health endpoint, and after accepting automatic restart behavior.

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

## Terminal-only development updates

Use Java 21 for Android Gradle builds. If necessary install it with `brew install openjdk@21`. Run `git pull --ff-only origin main && npm run mobile:update` on the Mac. The script builds both apps, copies the debug APK to Desktop and installs on connected devices. Set `QZU_DEPLOY_HOST` and optionally `QZU_SSH_KEY` to include Oracle deployment. Set `QZU_INSTALL_JAVA=1` to allow installing OpenJDK 21 using Homebrew if missing. A single available paired iPhone is detected automatically. Set QZU_IOS_DEVICE to its Xcode device UDID to select it explicitly, or to skip to build without installing. If no unique iPhone is detected, the script builds without installing. No IDE windows are opened. Restarting Oracle clears active conversations.

## Publish a signed Android release

After testing the release build, run `QZU_DEPLOY_HOST=ubuntu@YOUR_SERVER QZU_SSH_KEY=PATH npm run publish:release` from clean, current main. It builds the signed APK, pins the initial production signing certificate, checks package/version and uploads the APK before restarting Oracle. It verifies the public HTTPS download by SHA-256. Set `QZU_USE_EXISTING_APK=1` only for an already-tested APK of the current version; this skips rebuilding and does not prove the APK was built from the current Git commit. Never publish different binaries under the same version. Increase package.json version for new releases. The default release directory is data/releases; this workflow assumes that directory and the standard Ubuntu installation. Server restart ends temporary conversations. iOS distribution is separate; no iOS binary is published by this command. Existing debug-signed Android installations require a migration and may lose device identity.

As of 0.9.6, new user-initiated support chats enter a persistent admin request inbox. Rejection hides the request without deleting messages; a new user message (or new deletion request) returns it to the inbox. Admin-initiated and previously existing conversations remain accepted. Normal users can write immediately; the support agent must accept before replying.

## 0.10.0 — official information, live updates and privacy

Official posts are persisted once in SQLite and available to all unlocked active accounts, including accounts activated later. The verified support account alone can publish. Per-account read cursors power the red unread dot; older posts can be loaded separately. This does not change the older CLI announcement mechanism.

Live updates use authenticated, bounded HTTPS long polling (not WebSockets); normal state polling is retained for older servers. Direct encryption still uses the existing experimental protocol: new clients submit the full safety code to bind confirmations to both signed keys, and wipe temporary byte buffers where possible. Older clients must update to confirm new encrypted chats. This is not an audited ratchet or a guarantee of memory erasure.

For privacy-conscious backups, use `npm run backup:private -- /private/path/qzu-backup.sqlite`. The script copies a consistent SQLite snapshot without support conversation rows or push tokens. Store the backup securely (account credentials and metadata remain sensitive). Do not back up the raw database, WAL files or support payloads if you want support deletions to remain effective after recovery. Existing backups must be retired separately; deletion cannot erase screenshots, exported content, historical backups or all filesystem remnants. Ordinary chats remain RAM-only; support rows use SQLite secure_delete and checkpoint attempts on deletion. Test restoration on a separate instance. Backups created by the new script intentionally do not restore support chats.

To preserve unused-key reveal when moving the deployment, separately transfer the `.access-key-vault` file next to the account database with mode `0600`. For the default database its path is `data/accounts.sqlite.access-key-vault`. Store it securely apart from SQLite backups. Existing access keys can still redeem after a restore without this file.

Optional private push delivery: run npm install on the mobile build machine, enable Push Notifications capability for iOS and configure APNs signing, and configure Firebase/FCM on Android with its google-services.json. Configure QZU_PUSH_RELAY_URL and QZU_PUSH_RELAY_SECRET in the server environment. The HTTPS relay must authenticate the bearer secret and deliver the provided platform/token/title/body through APNs or FCM. It receives only a token, platform and constant generic text, never sender, message, room or account ID. No credentials belong in the repository. Push is opt-in, throttled, and unavailable until the relay and native configuration are in place. Test notifications on actual devices; relay delivery is best effort, not guaranteed. The relay itself is not bundled. The in-app unread indicator works without push configuration.

## 0.10.1
Admin Settings has a separate admin-only section with support request and feedback counts. Feedback is stored without sender identifiers and is accessible only to unlocked admin accounts. Discord forwarding remains optional and best-effort. The private backup excludes feedback content. Previously forwarded Discord feedback is not imported or deleted by the app. The obsolete blanket encryption sentence in Info is removed; chat-specific encryption indicators remain.

## Google Play App Bundle

Run `npm run release:play` on the Mac to create a signed Android App Bundle in release-output. This uses the existing production keystore, prompts for passwords locally, requires the matching Firebase Android configuration and runs tests before building. For the first Play release, review Play App Signing options and preserve the existing production app signing certificate if existing direct-download installations must remain update-compatible. A Play upload key and app signing key may differ. Never upload a raw keystore to GitHub or share its password. Existing debug installations cannot update in place to a differently signed build. The generated bundle is intended for a Play Console draft/internal test; the current external paid access and APK update workflows need a Play policy review and adaptation before distributing a Play build. Do not reuse a version code already uploaded to Play. This command does not publish or deploy anything.

## 0.10.2 Google Play edition
The release:play script sets QZU_DISTRIBUTION=google-play. This edition only redeems existing access keys; it has no external purchase, renewal, payment instructions or direct APK update action. Direct builds retain their existing checkout. Deploy the server before installing updated clients. New accounts must accept the current Terms before messaging; existing legacy accounts retain write access until they accept Terms in the new client, to avoid locking out previously activated direct-distribution users. Every 0.10.2 client presents Terms before messaging. Set QZU_PRIVACY_OPERATOR and QZU_PRIVACY_EMAIL to the real operator and monitored address. Verify /privacy, /terms and /delete-account over HTTPS, reusable review access, reporting, blocking, moderation and deletion on test accounts before submission. Review the store declarations and screenshots against the real app. The operator must actively moderate abuse reports.

## 0.10.3
Version-only rebuild of the 0.10.2 Google Play edition with Android version code 10004 because 10003 was already registered in Play Console. No functional changes.

## 0.11.0 development — not production-ready
Development branch: develop/v0.11.0. New bottom navigation, independent unread state, text-free startup, contextual gestures, native key vaults, automatic signed room handshake, encrypted replies/reactions, media controls, push diagnostics and moderation evidence. Both new clients must be tested with the new server before release. Offline prekeys and an audited ratchet are not implemented; first-time sessions require both devices to connect. Existing lost keys cannot be recovered. Native key vaults need real iOS/Android verification; old clients retain manual handshake support. iOS local notifications and badge support are staged, remote APNs is not configured. Android FCM acceptance does not prove device delivery. Do not deploy this branch to Oracle or upload a new Play bundle until tests and device checks pass. Review privacy and data safety declarations for report evidence and key retention. Do not use production accounts for destructive tests.

## 0.11.1
Default temporary chat lifetime 24 hours (existing optional extension adds 30 minutes). Signed, one-time prekey pools enable new encrypted direct sessions for contacts who have unlocked the updated app and registered keys; no plaintext fallback. Keys are consumed once, and private material is retained in device vaults until consumed or expired. This is an extension of the existing protocol, not an independently audited ratchet. Temporary chats remain in server memory and can disappear after a server restart. The startup animation completes before PIN authentication. Optional background lock setting keeps an in-memory session for up to 12 hours of inactivity; cold launches and revoked sessions still require a PIN. Both native builds and a server upgrade are needed.
