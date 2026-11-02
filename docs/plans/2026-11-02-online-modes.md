# Wi-Fi and Public Online Modes Implementation Plan

**Goal:** Provide separate same-Wi-Fi and public online entry points for shared four-seat games on desktop and mobile.

**Approach:** Reuse the existing rules and table UI. A Node.js + Socket.IO server owns each room, validates commands, supplies private seat-relative views and supports reconnecting with an opaque player token. LAN and public rooms are separate namespaces at the product level; the server can enable either or both. Single-player remains available.

**Affected areas:** `server/`, `package.json`, `js/online.js`, `js/online-view.js`, `js/ui.js`, `js/game.js`, `js/turn-clock.js`, both HTML entries, mobile offline support, launch/deployment files, documentation and focused online tests.

**Verification:** Socket.IO multi-client tests for both modes, privacy, authorization, duplicate/stale commands, seat mapping, tribute, AI, reconnect and server restart; existing focused offline/UI tests; real browser desktop/mobile checks.

### Task 1: Authoritative room service

- [x] Load the shared engine in an isolated Node runtime with no browser persistence.
- [x] Implement mode-specific rooms, seat selection, ready/start, AI fill, private views and validated/versioned commands.
- [x] Keep room snapshots and reconnect sessions on disk; clean up expired rooms.
- [x] Add HTTP static hosting with an explicit public-file allowlist, health/config endpoints and Socket.IO support.
- [x] Verify with independent real Socket.IO clients and engine invariants.

### Task 2: Browser connection and lobby

Depends on Task 1 protocol.

- [x] Add separate home entries and lobby forms for LAN and public service addresses.
- [x] Provide invitations, seat selection, readiness, room settings and connection feedback.
- [x] Store resume credentials per service/mode/room, resume after refresh and recover from disconnects.
- [x] Convert private server views into the existing local table view model without opponent hand data.

### Task 3: Shared table integration

Depends on Tasks 1–2.

- [x] Submit play/pass/tribute/autopilot/next-hand commands through the server in online games.
- [x] Use authoritative events and timestamps for table updates, feedback and turn clocks.
- [x] Keep online menus and orientation changes local; preserve single-player saves and behavior.
- [x] Verify all four seat perspectives, hand-end transitions and phone layouts.

### Task 4: Delivery and regression checks

- [x] Add a LAN launcher, public deployment configuration and operating instructions.
- [x] Update asset versions and mobile offline resource lists.
- [x] Run focused online integration, privacy, persistence and offline regression checks.
- [x] Inspect desktop and mobile UI in a browser; document any external deployment prerequisites accurately.

Public server source and deployment files are in scope. Selecting or buying a hosting account is not assumed; an actually deployed public URL requires an available deployment target.

## Validation result

- 11 online integration cases passed with real local Socket.IO connections.
- Desktop LAN and mobile public-mode browser flows passed, including seat rotation, play, refresh and reconnect.
- Existing DOM, offline, spectator, table, viewport and AI worker checks passed.
- The release ZIP was extracted into a separate temporary directory, installed with production-only dependencies and successfully created both LAN and public rooms.
- Docker Compose configuration validates; the local Docker daemon is stopped, so container execution was not tested. No public deployment was performed.
