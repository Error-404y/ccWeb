# qzu. mobile setup

Use Node 22.13+, Xcode 26+ and Android Studio 2025.2.1+ with the Capacitor 8 toolchain.

1. Set `NODE_ENV=production`, `PUBLIC_ORIGIN` to your HTTPS server origin and `QZU_MOBILE_ONLY=true` on the backend. Persist the SQLite database.
2. Run `npm ci` and `npm test`.
3. Run `npm run mobile:ios` on macOS or `npm run mobile:android`. The generated apps use `https://qzu.duckdns.org` unless you set `QZU_APP_ORIGIN`. Set it to the same HTTPS origin served by your backend.
4. On iOS, select your development team in Signing & Capabilities, select a connected iPhone, and run the App target. On Android, choose a connected device in Android Studio and run the app.

The preparation script generates the native projects and packages the web assets. See [the release guide](RELEASES.md) for signed builds and Google Play packaging.

The iOS app stores its device key using Secure Enclave and a device-only Keychain entry. Android uses Android Keystore. Verify device activation on physical hardware. Users can create an account recovery code under Settings → Account and use it with their existing login PIN on a new device.

Android uses the configured Firebase delivery service for optional notifications. iOS remote notification delivery requires an appropriate push configuration. The settings page reports whether the device has registered.

For local web testing, set `QZU_MOBILE_ONLY=false`. Ordinary conversations remain in server memory and end on restart, while stored support cases follow their retention settings.
