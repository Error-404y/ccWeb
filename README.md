# qzu. v0.2

Minimal temporary messenger for qzu.cc. Node 22.13+ (24 LTS recommended).

```sh
npm install
npm test
npm start
```

Open http://localhost:3000. Separate browser profiles act as separate anonymous accounts. HTTPS is required for production and camera use outside localhost.

## Codes and locking

- First visit: choose and confirm a six-digit login PIN. Existing accounts migrate on next visit. The anonymous browser cookie remains the account identity; a PIN is not a global username or recovery credential. A forgotten login PIN has no recovery mechanism. Clearing cookies loses the account.
- Every full reload or tab visibility loss locks the UI, removes chat content and drafts from the DOM, stops the camera, and revokes the current tab's server unlock token where connectivity permits. Tokens live in memory and expire after 45 seconds without requests. Internal Chat, Connect and Settings navigation stays unlocked. Other tabs have independent locks. Browser/OS visibility signals are not a guaranteed screen-lock mechanism.
- Settings > Change login PIN requires the current PIN; other unlock tokens are revoked on change. Both login and emergency PINs use independent salted scrypt hashes and persistent attempt limits.
- Invite codes are unique while active in a single server process, last ten minutes, and are regenerated manually after expiry. QR codes contain an invite URL, not a login PIN.
- Conversations expire 30 minutes after creation. No setting can disable expiry; messages and chats live in server memory and are not backed up. No push notifications.

## emg.exe and Discord

In Settings, open emg.exe and choose/confirm a separate six-digit PIN. It can only be set once, unless a developer approves a reset. Execution deletes all conversations involving the authenticated account and its invite, and invalidates the emergency PIN. The login PIN is unaffected. Other people's unrelated conversations remain intact.

Copy .env.example to .env and set QZU_RESET_WEBHOOK to a newly generated Discord webhook URL. Never commit the URL, expose it to the browser, or share it publicly. npm start loads .env automatically. The application sends exactly:

```
Time: HH:MM:SS
Reference: <private reference>
Applied
```

Swiss time (Europe/Zurich, including daylight saving). The reference is never returned to the user. A successful request stays pending; delivery failures can be retried with the same reference. Delivery is not exactly-once if a network failure occurs after Discord accepts a message. The developer must verify and approve requests; the webhook itself is not an admin authentication mechanism.

On the server with the same SQLite database:

```sh
npm run reset-pin -- REQUEST_REFERENCE
```

After approval the user opens Settings > emg.exe and sets a new PIN. No old PIN is revealed. Future external admin tooling can call the server-side approveReset function through a separately authenticated, audited service; no public admin endpoint exists yet.

## Deployment and limitations

Single process only. Restarting clears all chats, invites and unlock tokens. SQLite persists account/session digests, PIN hashes and request metadata, with schema migration from v0.1. Set NODE_ENV=production and PUBLIC_ORIGIN=https://qzu.cc behind an HTTPS reverse proxy, persist data/, and only set TRUST_PROXY=1 if exactly one trusted proxy overwrites forwarding headers. GitHub Pages cannot host the backend.

Not security-audited or end-to-end encrypted; the server operator could access active message text. Browser visibility and network events are best-effort; screenshots, copied messages, offline devices and physical memory remnants cannot be guaranteed erased. No forensic deletion. Account metadata has no automatic retention policy. Before production, review abuse controls, authentication, encryption and privacy obligations. Run npm test and test on real desktop and mobile browsers.
