# qzu. Mobile foundation

Use Node 22.13+, Xcode 26+ and Android Studio 2025.2.1+ with the Capacitor 8 toolchain.

1. Deploy the updated Node backend at your HTTPS origin (default https://qzu.cc). Set NODE_ENV=production, PUBLIC_ORIGIN=https://qzu.cc and QZU_MOBILE_ONLY=true. Persist data/accounts.sqlite. Do not publish secrets.
2. npm install && npm test
3. npm run mobile:ios (on macOS) or npm run mobile:android. To use a different HTTPS server, prefix the command with QZU_APP_ORIGIN=https://your-host.
4. In Xcode select the App target, Signing & Capabilities, your Apple development team, and your connected iPhone. Enable Developer Mode on the phone if requested, then Run.
5. In Android Studio select a connected phone and Run. Use Generate Signed Bundle / APK for release distribution.

The preparation script generates native projects and copies the shared frontend locally; it does not create signed distribution files. iOS device keys require a physical Secure Enclave-capable iPhone. The iPhone private key is stored via Secure Enclave and device-only Keychain; Android uses Android Keystore. The server stores a public-key fingerprint and checks signed API calls. Access keys remain single-use. There is no automatic account transfer or recovery if the device key is lost. Existing browser accounts are not migrated. To test the web version locally use QZU_MOBILE_ONLY=false; production defaults to mobile-only.

The app retains PIN authentication; Face ID, final app icon and signing are subsequent work. No push notification service is included. Android hardware-backed key availability varies; device signatures are not app attestation. Production requires HTTPS and security review.

Two-way Admin support is available from the private server terminal: npm run admin-support-start -- CODE "Hello"; npm run admin-support-list; npm run admin-support-send -- ROOM_ID "Reply". Only a current personal connection code starts a support room; the room is separate from read-only announcements and expires after 30 minutes. Admin support is text-only and does not expose other conversations.
