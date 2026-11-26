# qzu. 0.12.0 Motion release gate

Keep main and the production Oracle instance unchanged until these checks pass.

## Automated checks

- `npm install` and `npm test` (Node 22+).
- `node --check public/app.js` and `node --check server.mjs`.
- Verify old and new encrypted send endpoints, request ID scope, duplicate retries, expiry, deleted messages and existing Firebase tests.
- Verify iOS local notification build and Android build on native tooling.

## Staging/device checks

Use a separate HTTPS server running this branch, not production. Build mobile apps with its bare HTTPS origin using QZU_APP_ORIGIN. Do not delete production apps or their device keys. Prefer spare devices/test accounts; native bundle IDs are unchanged.

- Cold start: Ignition completes before PIN, reduced motion skips it, resume doesn't replay it.
- Switch Chats, Connect and Settings; open and return from chats; no flashing/overlapping screens; keyboard does not cover composer.
- Send and receive direct encrypted text, photo and voice; reactions, replies, receipts, view-once and support behavior unchanged.
- Navigate between two chats, preserve drafts and scroll position while unlocked. Lock, emergency delete and expiry clear temporary state.
- Airplane mode with an established direct chat: queue encrypted text, reconnect while unlocked, verify exactly one copy on both devices. Test server accepts a request but connection drops before response. Test discard, failure and expiry.
- Older server lacks queuedSends: online send still works; offline drafts remain until reconnect. Group/support text and attachments are not queued.
- QR image must remain valid and scannable; regenerate, verify lifetime indicator and scan feedback; connection approval unchanged.
- Android fresh install: notification permission requested once after unlock, approve and receive real message alert while backgrounded. Verify badges, decline permission, explicitly turn off and enable again. Existing opt-outs remain respected.
- iOS: test local foreground and background notification and badge; remote APNs remains deferred.
- Verify no server restart on production until deployment approved. Temporary rooms live in RAM and would disappear on restart.

The queue holds encrypted text envelopes in memory only, bounded to 30 messages, and is discarded on lock/expiry or process termination; it is not durable offline storage. Drafts and scroll positions are likewise session-only. No plaintext fallback or new persistent storage was introduced.
