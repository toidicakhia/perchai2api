# Changelog

All notable changes to this plugin. Versions follow [semver](https://semver.org/);
the format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

Magpie has no npm-registry requirement: a plugin spec can be any tarball URL.
Two kinds of release therefore exist, and both are produced by one command —
see [RELEASING.md](RELEASING.md).

---

## [0.2.0] — 2026-10-24

First version that is a real, installable package. Everything below was built
against the live service: the plugin, its sign-in, and its request translation
were all exercised against `chat.perchai.app` / `app.perchai.app` before this
version was tagged.

### Added

- **Provider plugin** `perchai2api` — serves Perchai's hosted models to magpie
  as an ordinary `@ai-sdk/openai-compatible` provider, translating each request
  into Perch's own `/api/perch-terminal/model-call` envelope and translating the
  answer back to OpenAI SSE.
- **Three sign-in methods.**
  - `browser` — read the Supabase session out of the browser store this machine
    already has signed in to chat.perchai.app. No window, no consent screen, no
    loopback port.
  - `oauth` — the PKCE browser flow, for machines whose browser is signed out,
    or to sign in as a different account.
  - `api` — paste an existing Supabase access token.
- **Default system persona** (`prompt.mjs`) prepended by `withSystem` when the
  caller sends no non-empty `system` message. This is load-bearing, not
  cosmetic: see [Fixed](#020---2026-10-24) below.
- **Automatic session renewal** on the way into a request, writing the rotated
  refresh token back to magpie's Auth record.
- **Browser-cookie fallback for a spent refresh token** — when Supabase reports
  the saved token as already used (the browser signed in again and rotated it),
  the plugin re-reads the cookie store instead of demanding a new sign-in.
- **`usage` reporting** — account, tier, and the default model Perch would pick;
  never marks the account lapsed (`signIn: "kept"`).
- **Token-burst handling** — a `turn_rate_limited` 429 drops the cached turn
  ticket and backs off exponentially instead of failing the turn.

### Fixed

Hard problems solved during development, kept here because each one is a trap
that a future change could walk back into.

- **`perch_surface_required` 403 on every request.** Root cause was the
  **absence of a non-empty `system` message** in the outbound envelope — Perch
  reads that as direct API access and refuses it. Fixed by `withSystem` +
  `prompt.mjs`. Not attributable to plan tier, `preferredModelId`,
  `attribution`, or header shape; those were each ruled out by A/B isolation.
- **`attribution.workspaceId` sent empty.** The workspace id is not in the
  `turn-ticket` response body — it is the `wid` claim inside the ticket JWT, so
  it can only be filled *after* the ticket is minted. Fixed via `claimOf()` and
  a backfill in `call()`.
- **Wrong User-Agent.** The plugin claimed `perch-cli/2.4.116 unknown`; the real
  CLI sends `perchai-cli/2.4.116`. Fixed.
- **Account dropped as lapsed every hour.** A Supabase access token lives one
  hour, and magpie reads `expires` *before* it loads the plugin, so any real
  expiry value made magpie discard a perfectly renewable account hourly. The
  Auth record now stores `expires: 0` and the plugin renews from
  `blob.expiresAt` itself.
- **`sqlite3 -readonly` fails on macOS** (`unable to open database file (14)`).
  The flag is dropped; the target is already a throwaway copy of a store a
  running browser holds open.
- **Cookie-store reads against a live browser** — lock contention handled by
  copying the store aside before querying it.

### Known limitations

- **Chromium-family cookie stores are not read.** Chrome/Edge/Brave seal cookie
  values with a login-keychain key on macOS. The harvest reports such a store as
  unreadable rather than guessing; methods `oauth` / `api` cover those machines.
  Firefox is read directly and is the verified path.
- **"Automatic token grab" is not a daemon.** It reads the browser cookie once,
  at sign-in; after that the plugin keeps itself alive with the refresh token.
  If Perch ever truly invalidates that token (long disuse, password change), one
  `magpie plugin login perchai2api` is still required.
- **Throttling can look like a timeout.** Perch meters turn tickets per account.
  Back-to-back turns show up as slowness rather than errors, but
  `magpie provider test` run moments after a burst can time out — wait ~1 min.
- **Repeated-recovery stability is unproven.** The spent-refresh-token fallback
  is confirmed to *execute* (the failure mode changes from a bare
  `validation_failed` throw to the cookie re-read), but the automated assertion
  for repeated recovery never went green: the recovery itself rotated the
  browser's copy, so the follow-up assertion consumed an already-spent token.
  Treat continuous recovery as "triggers", not "proven stable".
- **DeepSeek V4.1 Flash through magpie's gateway** needs a gateway key scoped to
  the provider. The default key is scoped to `group/ds-4.1` and refuses
  `perchai2api/…` with a `permission_error`; widen the key's model list on
  magpie's Gateway page to use this provider's model ids through the gateway.

---

## [0.1.0]

Never published. Internal working version while the protocol translation was
being reverse-engineered; superseded by 0.2.0 before any install outside the
development machine.
