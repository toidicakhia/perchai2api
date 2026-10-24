# @magpie-community/perchai2api

Signs in to **Perchai** ([chat.perchai.app](https://chat.perchai.app)) the way the Perch CLI
does, and serves Perch's hosted models to magpie through Perch's own
`/api/perch-terminal/model-call` proxy.

```
magpie plugin add @magpie-community/perchai2api
magpie plugin login perchai2api          # pick method 2 below: no browser window
magpie plugin list                       # perchai2api (Perchai, 28 models) signed in as …
```

`magpie plugin login perchai2api <method>` passes the method by name
(`oauth`, `browser`, `api`), so magpie does not print its "how do you sign
in" menu first. Piping that menu's answer (`printf '2\n' | magpie plugin
login …`) also works.

## Sign-in

Three ways in, all kept in magpie's Auth like any other OAuth provider:

- **Use the session this browser is already signed in with** (method
  `browser`) — the shortest one, and the one to reach for. If you are signed
  in to chat.perchai.app in a browser on this machine, its Supabase session
  is already in that browser's cookie store; the plugin reads it, so there is
  no window to click, no consent screen, and no loopback port. Worst case it
  is a single command to get back in after anything goes wrong.
- **Sign in (Google, GitHub, or email)** (method `oauth`) — the browser flow.
  The plugin reads `/api/perch-terminal/cli-auth/config` to learn which
  Supabase project and which OAuth providers the app has on, starts a PKCE
  flow, listens on a loopback port for `?code=`, and exchanges the code for a
  Supabase session. `PERCHAI_OAUTH_PROVIDER` picks the provider when it is
  one of the enabled ones (default `google`, falling back to the first the
  app enables). Use this on a machine whose browser is not signed in, or to
  sign in as a different account.
- **Access token** (method `api`) — paste a Supabase access token if you
  already have one. No refresh token to go with it, so the sign-in lasts
  until Perch stops accepting the token.

### How the cookie is read

chat.perchai.app stores its session as a chunked cookie
(`sb-<ref>-auth-token.0`, `.1`, …) whose values concatenate into one
`base64-`-prefixed JSON session. The plugin enumerates the cookie stores this
machine's browsers keep, copies the store aside (a running browser holds it
open, and SQLite refuses a locked file), and joins the chunks by their
numeric suffix. A session whose access token has already expired is still a
sign-in: the refresh token in the same cookie renews it.

Firefox is read directly. Chromium-family browsers (Chrome, Edge, Brave)
seal their cookie values with a key from the login keychain, so the harvest
reports that store as unreadable rather than guessing — method `oauth` or
`api` covers those machines. The stores tried, and why each was skipped, are
named in the error when no session is found.

### Session lifetime

The session's access token is `access`; `refresh` holds the rest (app URL,
Supabase URL and key, refresh token, expiry, user). A stale session is
renewed on the way into a request and the new pair is written back, because
Supabase rotates refresh tokens.

The record's `expires` is deliberately **`0`**, not the access token's own
end. A Supabase access token lasts an hour, and magpie reads `expires` before
it loads the plugin — a real value there would have magpie drop the account
as lapsed every hour even though the refresh token keeps it alive. The plugin
renews from `blob.expiresAt` on its own, so the account stays signed in until
Perch actually refuses the refresh token.

App URL defaults to `https://app.perchai.app`, overridable with
`PERCH_CLI_APP_URL` / `PERCH_APP_URL`. `PERCH_MODEL_CALL_PROXY_URL` points
model-call at a different host. `PERCH_CLI_VERSION` sets the version the
User-Agent claims.

## Requests

magpie talks to this provider as `@ai-sdk/openai-compatible`; the plugin
translates each request into Perch's envelope:

| magpie sends | plugin sends Perch |
|---|---|
| `messages[]` (string or text/image/file parts, `tool_calls`, `tool_call_id`) | `request.messages` in Perch's shape |
| `tools[]`, `tool_choice` | `request.tools`, `request.toolChoice` |
| `max_tokens` / `max_completion_tokens` | `request.maxOutputTokens` |
| `temperature`, `response_format` | `request.temperature`, `request.responseFormat` |
| `reasoning_effort` | `request.reasoning` |
| `model: "claude-sonnet-5.5"` | `manualModelOptionId` (a Perch manual model name) |
| `model: "anthropic-claude-sonnet-5-5"` | `preferredModelId` (a provider option id) |
| `model: "auto"` | neither — Perch routes it |

Every call goes out as the sanctioned CLI surface (`clientSurface: "cli"`,
`raceMode: "single"`, the CLI User-Agent, and the turn ticket Perch's proxy
mints at `/api/perch-terminal/turn-ticket` when it enforces one).

The answer comes back as OpenAI SSE: Perch's `reasoning_delta` becomes
`reasoning_content`, `text_delta` becomes `content`, `tool_call_delta` /
`tool_use_end` become `tool_calls`, `stream_restart` clears what was sent,
and Perch's `done` closes the stream with `finish_reason` and `usage`. A
`stream: false` request is assembled into one `chat.completion`.

## Failure

Perch's error codes are passed through as readable errors: a spent
allowance is a 429 `rate_limit_error` with Perch's reset date and tier
list; `starter_model_blocked` and `perch_surface_required` are 403; a
dropped session is a 401 that the plugin heals once by renewing and
replaying. `usage` reports the account and the default model Perch would
pick, and never marks the account lapsed (`signIn: "kept"`) — Perch's
limits are Perch's to announce.

A `turn_rate_limited` 429 is throttling, not a wall: Perch meters turn
tickets per account and pushes back on a burst, so the plugin drops its
cached ticket, backs off, and mints a new one. Firing turns back to back
therefore shows up as slowness, not errors — but `magpie provider test`
run moments after a burst can still time out, so give it a minute.

If Perch refuses the saved refresh token because the browser signed in
again and rotated it, the plugin reloads the session from the browser's
cookie store and carries on, rather than asking for a fresh sign-in.

