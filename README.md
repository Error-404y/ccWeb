# qzu.

A minimal anonymous messenger for qzu.cc. No phone numbers, public usernames, custom avatars, notification permissions, or chat backups.

## Run locally

Requires Node.js 22.13+ (Node 24 LTS recommended).

```sh
npm install
npm test
npm start
```

Open http://localhost:3000. Use a separate browser profile or private window for the other participant. Generate/share an invite code on Connect. A QR code opens the same website with the invite prefilled. Camera access works on localhost or HTTPS.

## Behavior

- An opaque session cookie identifies each browser. The server never exposes account identifiers to other users. Clearing cookies loses the identity and its PIN.
- Invite codes are six characters, unique among active invites, valid for ten minutes. Expired codes are not automatically renewed. An initial code is issued at onboarding; New code replaces the previous one.
- A conversation (including its contact entry and all messages) expires 30 minutes after connection, regardless of activity. The server checks expiry on every operation and sweeps every second. No toggle. No message history is persisted to browser storage.
- Both participants can explicitly delete their shared conversation. emg.exe removes all conversations involving the authenticated browser and invalidates its invite, leaving other conversations untouched. Connected browsers synchronize through polling (~1.5 seconds); offline browsers clear volatile state and reconcile when they reconnect.
- A six-digit emergency PIN is issued once, salted and hashed, and invalidated on successful use. A forgotten/used PIN requires a developer-approved reset. Five wrong valid-format attempts lock PIN use for 15 minutes. The session cookie is required; a PIN alone cannot access an account.
- Settings and Connect are separate routes. Only interior panels scroll. The chat UI supports narrow screens, safe areas, touch controls, and light/dark/system themes. QR scanning uses a locally served decoder, no third-party requests.

## Developer PIN reset

The user requests a reset in Settings and gives the developer the reference. Verify the request according to your support process; there is no email-based identity recovery.

On the server using the same account database:

```sh
npm run reset-pin -- REQUEST_REFERENCE
```

The next time the user's browser synchronizes, it can issue a replacement PIN. The developer does not see the original or replacement PIN. A reset invalidates the old PIN.

## Deployment

This is an MVP, **not a security-audited or end-to-end encrypted messenger**. Message text is held in server process memory; the operator could access it while active. HTTPS is required in production. Screenshots, external copies, device backups and physical memory remnants cannot be guaranteed erased. The app does not provide forensic deletion. No push notifications are implemented.

Run exactly one Node process/replica; invite uniqueness and chat state are held in memory. Restarting the server clears active chats and invites earlier than their deadlines. SQLite stores session digests, PIN hashes and reset metadata only. Persist the data directory for identity continuity. Do not expose the database or back it up alongside any chat data. Account metadata currently has no automatic retention policy.

Set environment variables on a Node hosting service or VPS:

```sh
NODE_ENV=production PUBLIC_ORIGIN=https://qzu.cc PORT=3000 npm start
```

Configure DNS and an HTTPS reverse proxy to the Node server. Set TRUST_PROXY=1 only if exactly one trusted proxy sits in front and overwrites forwarding headers; otherwise leave it unset. Keep direct backend access restricted. Set QZU_DB to a persistent SQLite path if desired. The domain is not configured or deployed by this repository. GitHub Pages cannot run the Node backend.

Before a public launch, review abuse controls, identity recovery, accessibility across real devices, encryption, privacy/retention requirements, and infrastructure logging. Current rate limits are process-local and intended for a small deployment.

## Tests

`npm test` covers invite collision/expiry, mandatory chat expiration, room authorization, scoped deletion, single-use PINs, reset approval and PIN lockout. Manual browser/device testing is also required.
