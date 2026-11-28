# qzu.

qzu. is a temporary messenger with native Android and iOS clients and a browser-based Control Center for administrators.

## Run locally

Use Node 22.13 or newer.

```bash
npm ci
npm test
npm start
```

Open [the local messenger](http://localhost:3000) or [Control Center](http://localhost:3000/control) on a supported desktop browser. Run `npm run admin-key` to create a local test admin key. For browser-only UI testing, start the server with `QZU_MOBILE_ONLY=false QZU_ACCESS_REQUIRED=false npm start`.

Run `npx playwright-core install chromium` and `npm run test:browser` for the browser smoke checks. The checks start their own server and use a temporary SQLite database.

- [Mobile setup](MOBILE.md)
- [Access, payment and renewals](ACCESS.md)
- [Build and deployment procedures](RELEASES.md)

Ordinary chats live in server memory and end when the server restarts. Persistent account and support data use SQLite.
