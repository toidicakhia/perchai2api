// Perchai (chat.perchai.app), as an OpenCode provider plugin for magpie.
//
// Perchai is the consumer chat product; the Perch CLI (perchai-cli, npm)
// signs in to it and calls its hosted models through a proxy the app runs:
// POST <app>/api/perch-terminal/model-call. That proxy is not an
// OpenAI-compatible endpoint — it takes Perch's own envelope and answers
// with Perch's own event stream — so this plugin is the adapter:
//
//   * sign-in is the CLI's own: /api/perch-terminal/cli-auth/config hands
//     back Supabase's URL, publishable key and the OAuth providers the app
//     has on, the plugin starts a PKCE flow, listens on a loopback port for
//     ?code=, and exchanges it for a Supabase session (access + refresh
//     token). The session is kept per this plugin's Auth, not in the CLI's
//     Keychain entry.
//   * a request the OpenCode client makes (OpenAI-shaped body at
//     <baseURL>/chat/completions) is read, and its messages, tools and
//     sampling settings are rewritten into Perch's model-call envelope:
//     {request: {lane, messages, tools, maxOutputTokens, temperature,
//     toolChoice, responseFormat, reasoning}, runId, lane, strictManual,
//     raceMode, preferredModelId, avoidModelIds, attribution,
//     clientSurface: "cli", manualModelOptionId}.
//   * Perch's event stream (data: {"type": ...} lines of text_delta,
//     reasoning_delta, tool_call_delta, tool_use_end, stream_restart and
//     done) is turned back into OpenAI chat.completion.chunk SSE, and a
//     non-stream request is assembled from `done` into one completion.
//
// Everything a request needs beyond the body — the turn ticket Perch may
// demand (x-perch-turn-ticket), the founder default model, the CLI's
// User-Agent — is fetched here, so the client stays a plain OpenAI client.
//
// The sign-in is kept as OpenCode keeps an OAuth one: `access` is the
// Supabase access token, `refresh` the rest as JSON (app URL, Supabase URL
// and key, refresh token, expiry, user), `accountId` the account's email.

import crypto from "node:crypto"
import http from "node:http"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawn, execFileSync } from "node:child_process"
import PROMPT from "./prompt.mjs"

const PROVIDER = "perchai2api"
const SITE = "https://chat.perchai.app"
const APP = "https://app.perchai.app"
const SB_URL = "https://zlfuvsfjtgsdtqcaykia.supabase.co"
const SB_KEY = "sb_publishable_w4R_pNkUpygBFIljZCoOlA_67ACg0FO"
const CLI_VERSION = "2.4.116"
const UA = "perchai-cli/" + CLI_VERSION
const EXPIRES_MARGIN_S = 90 // the CLI counts a session fresh if it lasts 90 s more
const CALLBACK_PATH = "/callback"
const OAUTH_TIMEOUT_MS = 120_000
const TICKET_MARGIN_MS = 30_000

// Perch's manual model names, as the app's tier list names them. A name
// crosses the wire as manualModelOptionId; the proxy also accepts the
// provider-scoped option ids (anthropic-claude-sonnet-5-5) as the request's
// `model`, which is what the ids below are for.
const MANUAL = [
  { name: "gpt-6.1-sol", label: "GPT-6.1 Sol", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-6-sol", label: "GPT-6 Sol", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-6-luna", label: "GPT-6 Luna", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-5.6-sol", label: "GPT-5.6 Sol", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-5.6-luna", label: "GPT-5.6 Luna", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-5.6-terra", label: "GPT-5.6 Terra", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "gpt-5.5", label: "GPT-5.5", context: 400_000, output: 128_000, reasoning: true, image: true },
  { name: "claude-opus-5.5", label: "Claude Opus 5.5", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  { name: "claude-sonnet-5.5", label: "Claude Sonnet 5.5", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  { name: "claude-haiku-5.5", label: "Claude Haiku 5.5", context: 200_000, output: 64_000, reasoning: true, image: true },
  { name: "opus-4.8", label: "Claude Opus 4.8", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  { name: "gemini-4-argon", label: "Gemini 4 Argon", context: 1_000_000, output: 128_000, reasoning: true, image: true },
  { name: "grok-4.7", label: "Grok 4.7", context: 256_000, output: 64_000, reasoning: true, image: true },
  { name: "grok-4.6", label: "Grok 4.6", context: 256_000, output: 64_000, reasoning: true, image: true },
  { name: "grok-4.3", label: "Grok 4.3", context: 256_000, output: 64_000, reasoning: true, image: true },
  { name: "qwen-3.8-max", label: "Qwen 3.8 Max", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "qwen-3.8", label: "Qwen 3.8", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "qwen-3.8-flash", label: "Qwen 3.8 Flash", context: 262_000, output: 32_000, reasoning: false, image: false },
  { name: "kimi-3.1-pro", label: "Kimi 3.1 Pro", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "kimi-3", label: "Kimi 3", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "glm-5.3", label: "GLM-5.3", context: 200_000, output: 64_000, reasoning: true, image: false },
  { name: "glm-5.3-flash", label: "GLM-5.3 Flash", context: 200_000, output: 64_000, reasoning: true, image: false },
  { name: "deepseek-v4.1-flash", label: "DeepSeek V4.1 Flash", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "deepseek-v4", label: "DeepSeek V4", context: 262_000, output: 64_000, reasoning: true, image: false },
  { name: "minimax-m3", label: "MiniMax M3", context: 200_000, output: 64_000, reasoning: true, image: false },
  { name: "nemotron-ultra", label: "Nemotron Ultra", context: 200_000, output: 64_000, reasoning: true, image: false },
  { name: "nemotron-lightning", label: "Nemotron Lightning", context: 200_000, output: 32_000, reasoning: true, image: false },
]

// The ids a fresh sign-in lists before the account's own list is read.
const MODELS = MANUAL.map((m) => m.name)

const LANES = new Set(["chat", "thinking", "writer", "report", "vision", "code", "worker", "sandboxPlanner"])
const STREAM_TIMEOUT_MS = 600_000
const TICKET_TIMEOUT_MS = 8_000

const STATUS_TEXT = {
  400: "Bad Request",
  401: "Unauthorized",
  402: "Payment Required",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  408: "Request Timeout",
  409: "Conflict",
  413: "Payload Too Large",
  422: "Unprocessable Entity",
  425: "Too Early",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
}

const first = (...ss) => ss.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? ""
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nowSec = () => Math.floor(Date.now() / 1000)

// slug is the option id Perch makes of a provider and a model: lowercased,
// with everything but letters and digits turned into a dash.
const slug = (provider, model) =>
  `${String(provider).replace(/_/g, "-")}-${String(model).replace(/[^a-zA-Z0-9]+/g, "-").toLowerCase()}`

// entryOf is a model the way OpenCode's config wants it.
function entryOf(m) {
  return {
    name: m.label ?? m.name,
    limit: { context: m.context ?? 200_000, input: m.context ?? 200_000, output: m.output ?? 64_000 },
    attachment: !!m.image,
    reasoning: !!m.reasoning,
  }
}

// ---- talking to Perchai ------------------------------------------------------------

class PerchError extends Error {
  constructor(message, status, errorCode) {
    super(message)
    this.status = status
    this.errorCode = errorCode
  }
}

// appOf normalises the app URL and, with what is in the sign-in or the
// environment, is where every call goes. A path already pointing at an
// endpoint is left alone, as the CLI leaves it.
function appOf(...candidates) {
  const raw = candidates.map((s) => (typeof s === "string" ? s.trim() : "")).find((s) => s) ?? APP
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    const u = new URL(withScheme)
    u.pathname = u.pathname.replace(/\/+$/, "")
    u.search = ""
    u.hash = ""
    return u.toString().replace(/\/+$/, "")
  } catch {
    return APP
  }
}

// endpoint is where a Perch endpoint lives under the app URL.
function endpoint(app, path) {
  const base = app.replace(/\/+$/, "")
  return base.endsWith(path) ? base : base + path
}

// stateOf reads what the sign-in kept.
function stateOf(auth) {
  if (!auth) return null
  const access = first(auth.access, auth.type === "api" ? auth.key : "")
  if (!access) return null
  if (auth.type === "api") {
    // an API-key sign-in only has the token; the rest is Perch's defaults
    return {
      access,
      refreshToken: "",
      supabaseUrl: SB_URL,
      supabaseKey: SB_KEY,
      appUrl: appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL),
      expiresAt: 0, // no expiry to read: the token is used until Perch refuses it
      userId: null,
      email: "",
      accountId: first(auth.accountId, "Perchai"),
    }
  }
  let blob = {}
  try {
    blob = JSON.parse(auth.refresh ?? "{}") ?? {}
  } catch {
    blob = {}
  }
  return {
    access,
    refreshToken: first(blob.refreshToken, auth.refreshToken),
    supabaseUrl: first(blob.supabaseUrl, SB_URL),
    supabaseKey: first(blob.supabaseKey, SB_KEY),
    appUrl: appOf(blob.appUrl, process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL),
    expiresAt: Number.isFinite(Number(blob.expiresAt)) ? Number(blob.expiresAt) : 0,
    userId: first(blob.userId, auth.uid),
    email: first(blob.email, auth.email),
    accountId: first(auth.accountId, blob.email, "Perchai"),
  }
}

const fresh = (s) => !!s?.expiresAt && s.expiresAt > nowSec() + EXPIRES_MARGIN_S

// cliHeaders are what the CLI puts on its own calls. The version belongs to
// the product name, so an override that already carries one must not add a
// second.
function cliHeaders(extra) {
  const h = {
    Accept: "application/json",
    "User-Agent": UA,
    ...extra,
  }
  return h
}

// ---- Supabase ---------------------------------------------------------------------

// sbAuth asks GoTrue for a session, passwordless: the OAuth code exchange,
// the refresh, and the profile read the sign-in's instructions need.
async function sbAuth(s, path, body, { signal } = {}) {
  const url = `${s.supabaseUrl.replace(/\/+$/, "")}/auth/v1/${path}`
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: s.supabaseKey, Authorization: `Bearer ${s.supabaseKey}` },
    body: JSON.stringify(body ?? {}),
    signal,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok) {
    const msg = first(json?.msg, json?.error_description, json?.error, json?.message, text.slice(0, 200))
    throw new PerchError(`Perchai sign-in: ${msg || `${res.status} ${STATUS_TEXT[res.status] ?? res.statusText}`}`, res.status, json?.error_code)
  }
  return json ?? {}
}

// sessionOf narrows GoTrue's session into what this plugin keeps.
function sessionOf(got) {
  const s = got?.session ?? got
  const user = s?.user ?? {}
  return {
    accessToken: first(s?.access_token),
    refreshToken: first(s?.refresh_token),
    expiresAt: Number.isFinite(Number(s?.expires_at)) ? Number(s.expires_at) : nowSec() + 3600,
    userId: first(user.id),
    email: first(user.email, user.user_metadata?.email),
    provider: first(user.app_metadata?.provider),
  }
}

// ---- signing in --------------------------------------------------------------------

// appFor resolves the host a call on `app` should really go to: the CLI
// asks the same question of the sign-in config, whose appUrl is the one the
// account's turns live on (a sign-in begun at chat.perchai.app is answered
// with app.perchai.app, which is where model-call is). Any failure keeps
// the host that was asked.
const canonical = new Map()
async function appFor(app) {
  if (canonical.has(app)) return canonical.get(app)
  let out = app
  try {
    const cfg = await cfgOf(app)
    if (cfg.appUrl) out = appOf(cfg.appUrl)
  } catch {}
  canonical.set(app, out)
  return out
}

// cfgOf reads the CLI sign-in config: where Perch's Supabase is, which
// OAuth providers the app has on, and where the callback may point.
async function cfgOf(app, signal) {
  const res = await fetch(endpoint(app, "/api/perch-terminal/cli-auth/config"), {
    headers: cliHeaders(),
    signal,
  })
  const text = await res.text()
  let json = {}
  try {
    json = JSON.parse(text)
  } catch {}
  if (!res.ok || !json?.ok) throw new PerchError(`Perchai gave no sign-in config (${res.status})`, res.status, json?.errorCode)
  const providers = Array.isArray(json.providers) ? json.providers.filter((p) => typeof p === "string") : []
  return {
    appUrl: first(json.appUrl, app),
    supabaseUrl: first(json.supabaseUrl, SB_URL),
    supabaseKey: first(json.supabaseAnonKey, SB_KEY),
    redirectHost: first(json.redirectHost, "127.0.0.1"),
    providers,
  }
}

// oauthStart asks GoTrue for the provider's authorize URL without letting
// it navigate: the plugin opens it in the browser itself and reads the
// code from its own loopback listener.
async function oauthStart(s, provider, redirectTo) {
  const params = new URLSearchParams({ provider, redirect_to: redirectTo, flow_type: "pkce" })
  if (provider === "google") params.set("query_params", JSON.stringify({ prompt: "select_account" }))
  const url = `${s.supabaseUrl.replace(/\/+$/, "")}/auth/v1/authorize?${params}`
  const res = await fetch(url, {
    redirect: "manual",
    headers: { apikey: s.supabaseKey, Accept: "application/json, text/plain, */*" },
  })
  const location = res.headers.get("location")
  if (location) return location
  const text = await res.text()
  try {
    const json = JSON.parse(text)
    if (json?.url) return json.url
  } catch {}
  throw new PerchError(`Perchai sign-in: ${res.status} from Supabase authorize`, res.status)
}

// verifierOf makes a PKCE pair.
function verifierOf() {
  const verifier = crypto.randomBytes(48).toString("base64url")
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url")
  return { verifier, challenge }
}

function openBrowser(url) {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "cmd" : "xdg-open"
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url]
  try {
    const p = spawn(cmd, args, { stdio: "ignore", detached: true })
    p.unref()
  } catch {}
}

const page = (ok) =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${ok ? "Signed in" : "Sign-in failed"}</title></head>` +
  `<body style="font-family:system-ui;padding:32px;background:#100d0b;color:#fff8f0">` +
  `<h1>${ok ? "Signed in to Perchai" : "Perchai sign-in failed"}</h1>` +
  `<p>${ok ? "You can close this tab and go back to magpie." : "Start the sign-in again from magpie."}</p></body></html>`

// ---- taking the session a signed-in browser already has ----------------------------

// chat.perchai.app keeps its Supabase session in a cookie, and a browser that
// is signed in to the site has it already: harvesting the cookie is the
// shortest sign-in there is, because the human signed in long ago. The cookie
// is written in chunks (`<name>.0`, `<name>.1`, …) whose values concatenate
// into one `base64-` prefixed JSON session, so the parts are joined in order.
const SESSION_COOKIE = `sb-zlfuvsfjtgsdtqcaykia-auth-token`

// browserStores lists the cookie databases this machine's browsers keep, in
// the order they are tried. A profile's own store wins over a shared one.
function browserStores() {
  const home = os.homedir()
  const out = []
  const push = (file, kind) => {
    try {
      if (file && fs.existsSync(file)) out.push({ file, kind })
    } catch {}
  }
  if (process.platform === "darwin") {
    const ff = path.join(home, "Library/Application Support/Firefox/Profiles")
    try {
      for (const p of fs.readdirSync(ff)) push(path.join(ff, p, "cookies.sqlite"), "firefox")
    } catch {}
    const chrome = path.join(home, "Library/Application Support/Google/Chrome")
    try {
      for (const p of fs.readdirSync(chrome)) push(path.join(chrome, p, "Cookies"), "chromium")
    } catch {}
    push(path.join(home, "Library/Application Support/Chromium/Default/Cookies"), "chromium")
    push(path.join(home, "Library/Application Support/Microsoft Edge/Default/Cookies"), "chromium")
    push(path.join(home, "Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies"), "chromium")
  } else if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData/Roaming")
    const local = process.env.LOCALAPPDATA ?? path.join(home, "AppData/Local")
    const ff = path.join(appData, "Mozilla/Firefox/Profiles")
    try {
      for (const p of fs.readdirSync(ff)) push(path.join(ff, p, "cookies.sqlite"), "firefox")
    } catch {}
    for (const b of ["Google/Chrome", "Microsoft/Edge", "BraveSoftware/Brave-Browser"]) {
      push(path.join(local, b, "User Data/Default/Network/Cookies"), "chromium")
      push(path.join(local, b, "User Data/Default/Cookies"), "chromium")
    }
  } else {
    push(path.join(home, ".mozilla/firefox"), "firefox-dir")
    const snap = path.join(home, "snap/firefox/common/.mozilla/firefox")
    try {
      for (const p of fs.readdirSync(snap)) push(path.join(snap, p, "cookies.sqlite"), "firefox")
    } catch {}
    try {
      for (const p of fs.readdirSync(path.join(home, ".mozilla/firefox"))) push(path.join(home, ".mozilla/firefox", p, "cookies.sqlite"), "firefox")
    } catch {}
    for (const b of ["google-chrome", "chromium", "microsoft-edge", "BraveSoftware/Brave-Browser"]) {
      push(path.join(home, ".config", b, "Default", "Cookies"), "chromium")
    }
  }
  return out.filter((s) => s.kind !== "firefox-dir")
}

// sqliteRows runs one query with the system's sqlite3. It exists because a
// browser's own store is a SQLite file and nothing here should add a driver
// dependency to read it.
function sqliteRows(file, sql) {
  // no -readonly: macOS's own sqlite3 answers it with "unable to open
  // database file", and the file being read is already a throwaway copy
  const out = execFileSync("sqlite3", ["-separator", "\t", file, sql], {
    encoding: "utf8",
    timeout: 5000,
    stdio: ["ignore", "pipe", "ignore"],
  })
  return out.split("\n").filter(Boolean).map((line) => line.split("\t"))
}

// cookieParts reads the session cookie's chunks from one browser store. A
// live browser holds the file open, so the store is copied aside first and
// the copy is read: SQLite would otherwise refuse with "database is locked".
function cookieParts(store) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "perchai-cookies-"))
  const copy = path.join(tmp, "cookies.db")
  try {
    fs.copyFileSync(store.file, copy)
    // Chromium encrypts its values: the plaintext is not there to read
    const sql =
      store.kind === "firefox"
        ? `select name, value from moz_cookies where host like '%perchai.app' and name like '${SESSION_COOKIE}.%'`
        : `select name, value from cookies where host_key like '%perchai.app' and name like '${SESSION_COOKIE}.%'`
    const rows = sqliteRows(copy, sql)
    if (!rows.length) return null
    const byName = new Map(rows.map(([n, ...rest]) => [n, rest.join("\t")]))
    // the chunks are numbered; join them in that order, not the query's
    const names = [...byName.keys()].sort((a, b) => Number(a.split(".").pop()) - Number(b.split(".").pop()))
    const joined = names.map((n) => byName.get(n)).join("")
    const encrypted = joined.startsWith("v10") || joined.startsWith("v11") || !/^base64-|^\{/.test(joined)
    return { joined, encrypted, chunks: names.length }
  } catch {
    return null
  } finally {
    try {
      fs.rmSync(tmp, { recursive: true, force: true })
    } catch {}
  }
}

// sessionFromCookie turns the joined cookie value into the session it holds.
// The value is `base64-` + base64 of the JSON, possibly with the padding
// dropped, so it is decoded leniently and the object is read from the first
// { to its matching end.
function sessionFromCookie(joined) {
  const raw = String(joined ?? "").trim()
  if (!raw) return null
  const b64 = raw.startsWith("base64-") ? raw.slice("base64-".length) : raw
  let text = ""
  if (b64.startsWith("{")) {
    text = b64
  } else {
    const body = b64.replace(/-/g, "+").replace(/_/g, "/").replace(/[^A-Za-z0-9+/=]/g, "")
    try {
      text = Buffer.from(body, "base64").toString("utf8")
    } catch {
      return null
    }
  }
  const from = text.indexOf("{")
  if (from < 0) return null
  // a truncated cookie still carries the tokens at its head, so the longest
  // parseable object is what is taken
  for (let end = text.length; end > from + 2; end--) {
    if (text[end - 1] !== "}") continue
    try {
      const json = JSON.parse(text.slice(from, end))
      if (json && typeof json === "object" && (json.access_token || json.refresh_token)) return json
    } catch {}
  }
  return null
}

// harvestSession reads the signed-in browser's session, trying each store.
// It returns the session plus where it came from, or an error naming what
// was looked at, so a failed harvest says something useful.
function harvestSession() {
  const stores = browserStores()
  const tried = []
  for (const store of stores) {
    const got = cookieParts(store)
    if (!got) {
      tried.push(`${store.file} (no session cookie)`)
      continue
    }
    if (got.encrypted) {
      tried.push(`${store.file} (encrypted value; Chromium keeps its cookie store sealed)`)
      continue
    }
    const session = sessionFromCookie(got.joined)
    if (!session) {
      tried.push(`${store.file} (cookie present, unreadable)`)
      continue
    }
    return { session, from: store.file, kind: store.kind, chunks: got.chunks }
  }
  return { error: stores.length ? `no signed-in chat.perchai.app session found; looked at ${tried.join("; ")}` : "no browser cookie store found on this machine" }
}

// sessionToAuth is the Auth record a harvested (or refreshed) session becomes.
function sessionToAuth(got, { appUrl, supabaseUrl, supabaseKey, provider } = {}) {
  const session = sessionOf(got)
  if (!session.accessToken) return null
  const blob = {
    appUrl: first(appUrl, appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL)),
    supabaseUrl: first(supabaseUrl, SB_URL),
    supabaseKey: first(supabaseKey, SB_KEY),
    refreshToken: session.refreshToken,
    expiresAt: session.expiresAt,
    userId: session.userId,
    email: session.email,
    provider: first(session.provider, provider),
  }
  return {
    type: "success",
    refresh: JSON.stringify(blob),
    access: session.accessToken,
    // expires is 0, not the access token's own end: a Supabase access token
    // lasts an hour, and magpie reads `expires` before it loads the plugin,
    // so a real one would have the account dropped as lapsed every hour even
    // though the refresh token renews it. The plugin renews on its own, from
    // blob.expiresAt, whenever a call needs a fresher token — so the record
    // stays valid until Perch actually refuses the refresh token.
    expires: 0,
    accountId: session.email || session.userId || "Perchai",
  }
}

// signInFromBrowser runs the cookie harvest as a sign-in method. There is no
// browser window and nothing to wait for, but the method is shaped like the
// PKCE one — authorize, then callback — because that is the contract magpie
// drives: the harvest runs in callback, so a failure is reported as one.
async function signInFromBrowser(log) {
  const fail = (msg) => {
    log(msg)
    return { type: "failed", error: msg }
  }
  return {
    url: SITE,
    instructions: `Reading the chat.perchai.app session this browser is already signed in with. If none is found, sign in at ${SITE}/perchai and start this again.`,
    method: "auto",
    async callback() {
      const app = appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL)
      const got = harvestSession()
      if (got.error) return fail(`Perchai: ${got.error}. Sign in at ${SITE}/perchai in a browser and start this again.`)
      log(`found a chat.perchai.app session in ${got.from} (${got.chunks} cookie part${got.chunks === 1 ? "" : "s"})`)
      // the config names the Supabase the session belongs to and the app host
      // its turns live on; a harvest works without it, so a failure is not fatal
      let cfg = {}
      try {
        cfg = await cfgOf(app)
      } catch {}
      // an expired access token is still a sign-in: the refresh token renews it
      let session = got.session
      if (!session.access_token || Number(session.expires_at ?? 0) <= nowSec() + EXPIRES_MARGIN_S) {
        if (!session.refresh_token) return fail("Perchai: the browser's session has expired; sign in again in the browser")
        try {
          session = await sbAuth(
            { supabaseUrl: first(cfg.supabaseUrl, SB_URL), supabaseKey: first(cfg.supabaseKey, SB_KEY) },
            "token?grant_type=refresh_token",
            { refresh_token: session.refresh_token },
          )
        } catch (e) {
          return fail(e?.message ?? String(e))
        }
      }
      const auth = sessionToAuth(session, {
        appUrl: first(cfg.appUrl, app),
        supabaseUrl: cfg.supabaseUrl,
        supabaseKey: cfg.supabaseKey,
        provider: "browser-cookie",
      })
      if (!auth) return fail("Perchai: the browser's cookie held no session")
      return auth
    },
  }
}

// listener waits on a loopback port for the OAuth code.
async function listener(host) {
  let settle
  const got = new Promise((r) => (settle = r))
  const server = http.createServer((req, res) => {
    const u = new URL(req.url ?? "/", `http://${host}`)
    // the browser may knock first (favicon, a prefetch, a probe) — answer
    // it and keep waiting for the code instead of calling the sign-in off
    const code = u.searchParams.get("code")
    const said = u.searchParams.get("error_description") ?? u.searchParams.get("error")
    if (!code && !said) {
      res.writeHead(u.pathname === CALLBACK_PATH ? 200 : 404, { "Content-Type": "text/html; charset=utf-8" })
      res.end(page(true).replace("You can close this tab and go back to magpie.", "Waiting for Perchai to finish the sign-in…"))
      return
    }
    if (!code) {
      res.writeHead(400, { "Content-Type": "text/html; charset=utf-8" })
      res.end(page(false))
      settle({ ok: false, error: said })
      return
    }
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" })
    res.end(page(true))
    settle({ ok: true, code })
  })
  await new Promise((ok, no) => {
    server.once("error", no)
    server.listen(0, host, () => {
      server.off("error", no)
      ok()
    })
  })
  const port = server.address().port
  let timer
  const deadline = new Promise((r) => {
    timer = setTimeout(() => r({ ok: false, error: "the sign-in expired; start again" }), OAUTH_TIMEOUT_MS)
    if (typeof timer.unref === "function") timer.unref()
  })
  return {
    redirectTo: `http://${host}:${port}${CALLBACK_PATH}`,
    wait: async () => {
      const r = await Promise.race([got, deadline])
      clearTimeout(timer)
      return r
    },
    close: () => new Promise((r) => server.close(() => r())),
  }
}

// signIn runs one browser sign-in and returns the Auth to keep.
async function signIn(log, wanted) {
  const fail = (msg) => {
    log(msg)
    return { type: "failed", error: msg }
  }
  const app = appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL)
  let cfg
  try {
    cfg = await cfgOf(app)
  } catch (e) {
    return fail(e?.message ?? String(e))
  }
  const s = { supabaseUrl: cfg.supabaseUrl, supabaseKey: cfg.supabaseKey }
  const provider = cfg.providers.includes(wanted) ? wanted : cfg.providers.includes("google") ? "google" : cfg.providers[0]
  if (!provider) return fail("Perchai has no OAuth provider on; sign in with email or a GitHub account instead")
  const { verifier, challenge } = verifierOf()
  // GoTrue takes the PKCE verifier from the flow's state cookie: the
  // challenge rides the authorize URL, the verifier the exchange.
  const listen = await listener(cfg.redirectHost || "127.0.0.1")
  let authorize
  try {
    authorize = await oauthStart(s, provider, `${listen.redirectTo.replace(/\/+$/, "")}?code_challenge=${challenge}&code_challenge_method=s256`)
  } catch (e) {
    await listen.close()
    return fail(e?.message ?? String(e))
  }
  openBrowser(authorize)
  return {
    url: authorize,
    instructions: `Sign in to Perchai in the browser; this finishes on its own. (If the browser does not open, visit ${authorize})`,
    method: "auto",
    async callback() {
      try {
        const got = await listen.wait()
        if (!got.ok) return fail(got.error)
        const session = sessionOf(await sbAuth(s, `token?grant_type=pkce`, { auth_code: got.code, code_verifier: verifier }))
        if (!session.accessToken) return fail("Perchai's sign-in returned no session")
        // the CLI tells Perch where the account came from, so the proxy
        // knows this is a CLI surface account
        await fetch(`${s.supabaseUrl.replace(/\/+$/, "")}/auth/v1/user`, {
          method: "PUT",
          headers: {
            "Content-Type": "application/json",
            apikey: s.supabaseKey,
            Authorization: `Bearer ${session.accessToken}`,
          },
          body: JSON.stringify({ data: { signup_source: "cli" } }),
        }).catch(() => {})
        // cfg.appUrl is whichever host answered the config, corrected to the
        // app the CLI sign-in points at (a chat.perchai.app sign-in lands on
        // app.perchai.app, which is where model-call lives). sessionToAuth is
        // shared with the cookie harvest so both keep the same record shape,
        // including the expires: 0 that stops magpie dropping the account.
        const auth = sessionToAuth(session, {
          appUrl: first(cfg.appUrl, app),
          supabaseUrl: cfg.supabaseUrl,
          supabaseKey: cfg.supabaseKey,
          provider,
        })
        if (!auth) return fail("Perchai's sign-in returned no session")
        return auth
      } catch (e) {
        return fail(e?.message ?? String(e))
      } finally {
        await listen.close()
      }
    },
  }
}

// renewed refreshes a session that is no longer fresh. GoTrue rotates the
// refresh token, so the new pair has to be written back.
//
// A refresh can also be refused because something else spent the token first:
// signing in again in the browser rotates the session, and any store holding
// the old refresh token is left with a dead one ("refresh_token_already_used").
// The browser's own cookie store is then the newest truth on this machine, so
// instead of failing the request the renewal takes the session from there.
async function renewed(s, write) {
  if (!s.refreshToken) throw new PerchError("Perchai's sign-in has run out; sign in again", 401, "invalid_token")
  const got = sessionOf(await sbAuth(s, "token?grant_type=refresh_token", { refresh_token: s.refreshToken }).catch((e) => {
    // GoTrue names a spent token in errorCode; older answers put it in the
    // message, so both are checked rather than trusting one shape
    const why = String(e?.errorCode ?? "") + " " + String(e?.message ?? e)
    if (!/already_used|invalid_grant|refresh_token_not_found|not valid|validation_failed/i.test(why)) throw e
    const fresh = harvestSession()
    if (fresh.error || !fresh.session?.refresh_token) throw e
    return sbAuth(s, "token?grant_type=refresh_token", { refresh_token: fresh.session.refresh_token })
  }))
  const next = { ...s, access: got.accessToken, refreshToken: got.refreshToken || s.refreshToken, expiresAt: got.expiresAt }
  if (write) await write(next).catch(() => {})
  return next
}

// ---- the proxy ---------------------------------------------------------------------

// modelCallURL is where a request goes: the account's app URL, unless the
// environment points the proxy elsewhere (PERCH_MODEL_CALL_PROXY_URL), as
// the CLI allows.
function modelCallURL(app) {
  const raw = first(process.env.PERCH_MODEL_CALL_PROXY_URL)
  const fromEnv = raw ? (raw.endsWith("/api/perch-terminal/model-call") ? raw : `${raw.replace(/\/+$/, "")}/api/perch-terminal/model-call`) : ""
  return fromEnv || endpoint(app, "/api/perch-terminal/model-call")
}

// withSystem guarantees the messages Perch will actually serve. Perch hosts
// its models for the Web, Desktop and CLI surfaces only, and it reads a call
// with no system message as direct API access: it answers those with
// perch_surface_required no matter what clientSurface claims, which is why a
// body of nothing but user turns is refused. The CLI always sends its persona
// first, so the persona goes in front when the caller did not send one.
function withSystem(messages) {
  if (messages.some((m) => m && m.role === "system" && String(m.content ?? "").trim())) return messages
  // an empty system turn carries no persona, so it is replaced rather than
  // left to sit beside one
  return [{ role: "system", content: PROMPT }, ...messages.filter((m) => m?.role !== "system")]
}

// bodyOf reads an OpenAI chat body (or an Anthropic one, in case a client
// speaks that) into the pieces Perch's envelope wants.
function bodyOf(json) {
  const messages = []
  for (const m of Array.isArray(json?.messages) ? json.messages : []) {
    if (!m || typeof m !== "object") continue
    const role = m.role === "developer" ? "system" : m.role
    if (!role) continue
    const content = m.content
    let text = ""
    const parts = []
    if (typeof content === "string") {
      text = content
    } else if (Array.isArray(content)) {
      for (const p of content) {
        if (!p || typeof p !== "object") continue
        if (p.type === "text" && typeof p.text === "string") {
          text += p.text
          parts.push({ type: "text", text: p.text })
        } else if (p.type === "image_url" || p.type === "image") {
          const url = first(p.image_url?.url, p.source?.data ? `data:${p.source.media_type};base64,${p.source.data}` : "", p.url)
          if (url) parts.push({ type: "image_url", image_url: { url } })
        } else if (p.type === "file" && p.file?.file_data) {
          parts.push({ type: "file", file: { filename: p.file.filename ?? "upload", file_data: p.file.file_data } })
        }
      }
    }
    // tool results and tool calls ride along in the shape Perch's own
    // request builder writes them in
    const calls = Array.isArray(m.tool_calls)
      ? m.tool_calls
          .filter((c) => c && typeof c === "object")
          .map((c) => ({
            id: first(c.id) || `call_${crypto.randomBytes(6).toString("hex")}`,
            type: "function",
            function: {
              name: first(c.function?.name, c.name),
              arguments: typeof c.function?.arguments === "string" ? c.function.arguments : JSON.stringify(c.function?.arguments ?? c.arguments ?? {}),
            },
          }))
      : undefined
    const msg = { role }
    if (parts.length > 1) msg.content = parts
    else if (typeof text === "string" && text.length) msg.content = text
    else msg.content = ""
    if (typeof m.name === "string" && m.name) msg.name = m.name
    if (typeof m.tool_call_id === "string" && m.tool_call_id) msg.tool_call_id = m.tool_call_id
    if (calls?.length) msg.tool_calls = calls
    messages.push(msg)
  }
  const tools = []
  for (const t of Array.isArray(json?.tools) ? json.tools : []) {
    if (!t || typeof t !== "object") continue
    const fn = t.function ?? t
    if (!fn?.name) continue
    tools.push({
      type: "function",
      function: {
        name: fn.name,
        ...(fn.description ? { description: fn.description } : {}),
        parameters: fn.parameters ?? fn.input_schema ?? { type: "object", properties: {} },
      },
    })
  }
  const maxOutputTokens = Number(json?.max_completion_tokens ?? json?.max_tokens ?? 0) || undefined
  const temperature = typeof json?.temperature === "number" ? json.temperature : undefined
  const toolChoice =
    typeof json?.tool_choice === "string"
      ? json.tool_choice
      : json?.tool_choice?.function?.name
        ? { type: "function", function: { name: json.tool_choice.function.name } }
        : undefined
  const responseFormat = json?.response_format ?? (json?.output_format === "json" ? { type: "json_object" } : undefined)
  const effort = first(json?.reasoning_effort, json?.reasoning?.effort, json?.reasoning?.reasoning_effort)
  const reasoning = effort
    ? effort === "none"
      ? { enableThinking: false }
      : { reasoningEffort: effort, enableThinking: true }
    : undefined
  const wanted = first(json?.model)
  return { messages, tools, maxOutputTokens, temperature, toolChoice, responseFormat, reasoning, wanted, stream: !!json?.stream }
}

// optionOf turns the model a client asked for into Perch's two ways of
// naming one: the manual name (manualModelOptionId) and the provider
// option id (the request's model). "auto" leaves the choice to Perch.
function optionOf(wanted) {
  const name = first(wanted)
  if (!name || name === "auto" || name === "perch-auto") return { manual: null, preferred: null }
  const known = MANUAL.find((m) => m.name.toLowerCase() === name.toLowerCase())
  if (known) return { manual: known.name, preferred: null }
  // an option id (anthropic-claude-sonnet-5-5) is a preferred model, not a
  // manual one: manual selection is a plan feature, preferred is not
  return { manual: name.includes("-") && !name.includes(".") ? null : name, preferred: name }
}

// ticketFor mints the turn ticket Perch's hosted-model proxy may demand.
// A proxy that does not enforce them answers without one and the request
// goes without the header.
const tickets = new Map()
// learned keeps the account identity the ticket endpoint reports, because the
// model-call has to attribute the turn to the same user and workspace.
const learned = { userId: null, workspaceId: null }
// claimOf reads the ticket token's own claims without verifying it: the
// signature is Perch's to check, this only needs the ids it names.
function claimOf(ticket) {
  try {
    const part = String(ticket ?? "").split(".")[0]
    if (!part) return {}
    const json = JSON.parse(Buffer.from(part, "base64url").toString("utf8"))
    return json && typeof json === "object" ? json : {}
  } catch {
    return {}
  }
}

// RATE_LIMITED is what a throttled ticket mints instead of a token, so the
// caller can wait and ask again rather than treating it as a hard refusal.
const RATE_LIMITED = Symbol("perch.turnRateLimited")
async function ticketFor(s, app, runId, surface, signal, { retry = false } = {}) {
  const kept = tickets.get(runId)
  if (!retry && kept && kept.expiresAt - TICKET_MARGIN_MS > Date.now()) return kept.token
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), TICKET_TIMEOUT_MS)
  const stop = () => ctl.abort()
  signal?.addEventListener?.("abort", stop, { once: true })
  try {
    const res = await fetch(endpoint(app, "/api/perch-terminal/turn-ticket"), {
      method: "POST",
      headers: cliHeaders({ "Content-Type": "application/json", Authorization: `Bearer ${s.access}` }),
      body: JSON.stringify({ surface, profile: "standard" }),
      signal: ctl.signal,
    })
    const json = await res.json().catch(() => null)
    if (res.status === 429) {
      // a throttled ticket is always worth another look: Perch's own CLI
      // waits and re-asks, and the window frees up on its own
      const why = first(json?.error, "the Perch turn rate limit is reached")
      if (json?.enforced) throw new PerchError(why, 429, first(json?.errorCode, "turn_rate_limited"))
      return RATE_LIMITED
    }
    if (!res.ok || !json?.ticket) return null
    const expiresAt = Number.isFinite(Date.parse(json.expiresAt ?? "")) ? Date.parse(json.expiresAt) : Date.now() + 300_000
    const entry = { token: json.ticket, expiresAt, enforced: json.enforced === true }
    // the ticket names the workspace this turn is billed to, but only inside
    // its own token: attribution on the model-call has to repeat it or the
    // proxy reads the call as coming from somewhere else
    const claim = claimOf(json.ticket)
    if (claim.wid) learned.workspaceId = claim.wid
    else if (typeof json.workspaceId === "string" && json.workspaceId) learned.workspaceId = json.workspaceId
    if (claim.uid) learned.userId = claim.uid
    else if (typeof json.userId === "string" && json.userId) learned.userId = json.userId
    if (tickets.size > 32) tickets.delete(tickets.keys().next().value)
    tickets.set(runId, entry)
    return entry.token
  } catch (e) {
    if (e instanceof PerchError) throw e
    return null
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", stop)
  }
}

// refusalOf turns a model-call failure into what a client can read: the
// error code Perch named, the words it used, and Perch's own limit details.
async function refusalOf(res) {
  const text = await res.text().catch(() => "")
  let json = null
  try {
    json = JSON.parse(text)
  } catch {}
  const errorCode = first(json?.errorCode, res.status === 429 ? "usage_limit_reached" : "", res.status === 403 ? "starter_model_blocked" : "")
  const said = first(json?.error, json?.message, json?.msg, text.slice(0, 240).trim())
  const limit = json?.limit && typeof json.limit === "object" ? json.limit : null
  let error = said || `${res.status} ${STATUS_TEXT[res.status] ?? res.statusText}`.trim()
  if (errorCode === "perch_surface_required") {
    // Perch's plans host models for its own surfaces only; a request that
    // does not look like one is told so. The plugin sends the CLI surface,
    // so reaching this means Perch refused it anyway — say what it says.
    error = `${error} (Perch only serves these models to its Web, Desktop and CLI surfaces; this request went out as the CLI surface and was refused.)`
  }
  if (res.status === 401) {
    // Perch says only "Unauthorized"; the reason a magpie user sees it is
    // that the token it was handed is gone, so name the fix
    error = `${error} — Perchai's session is not valid any more; run magpie plugin login perchai2api`
  }
  if (limit) {
    const bits = [
      first(limit.heldLimit && `window ${limit.heldLimit}`, ""),
      first(limit.limitResetAt && `resets ${limit.limitResetAt}`, ""),
      first(typeof limit.remainingUsd === "number" && `remaining $${limit.remainingUsd}`, ""),
      first(limit.includedTiers?.length && `included ${limit.includedTiers.join("/")}`, ""),
      first(limit.upgradeTiers?.length && `upgrade ${limit.upgradeTiers.join("/")}`, ""),
    ].filter(Boolean)
    if (bits.length) error += ` (${bits.join(", ")})`
  }
  return { status: res.status, errorCode, message: error }
}

// explain is the error body OpenCode's provider layer reads.
const explain = (status, message, type) =>
  new Response(JSON.stringify({ type: "error", error: { type, message } }), {
    status,
    statusText: STATUS_TEXT[status] ?? "",
    headers: { "content-type": "application/json" },
  })

const typeOf = (status, errorCode) =>
  status === 401 ? "authentication_error" : status === 403 || errorCode === "perch_surface_required" ? "permission_error" : status === 429 ? "rate_limit_error" : "invalid_request_error"

// chunk is one OpenAI chat.completion.chunk.
function chunk(id, model, delta, finish) {
  return `data: ${JSON.stringify({
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`
}

// ---- the plugin --------------------------------------------------------------------

export async function Perchai2ApiPlugin({ client }) {
  const log = (message) => {
    try {
      client?.app?.log?.({ body: { service: "perchai2api", level: "error", message } })
    } catch {}
  }

  // withAuth reads the sign-in, renews it when it has gone stale, and
  // leaves the renewed pair in Auth so the next request starts fresh.
  const withAuth = async (getAuth, providerID, { force } = {}) => {
    const auth = await getAuth()
    const s = stateOf(auth)
    if (!s) throw new PerchError("not signed in to Perchai", 401, "not_authenticated")
    if (!force && (!s.refreshToken || fresh(s) || !s.expiresAt)) return s
    const write = async (next) => {
      if (auth?.type !== "oauth") return
      await client?.auth?.set?.({
        path: { id: providerID },
        body: { ...auth, access: next.access, refresh: JSON.stringify({ ...JSON.parse(auth.refresh ?? "{}"), refreshToken: next.refreshToken, expiresAt: next.expiresAt }) },
      })
    }
    return renewed(s, write)
  }

  // call does one model-call: 401 is healed once by renewing the session,
  // 5xx/408/425 are retried with the CLI's backoff.
  const call = async (getAuth, providerID, body, { signal } = {}) => {
    const app = await appFor(appOf(stateOf(await getAuth())?.appUrl, process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL))
    const url = modelCallURL(app)
    let s = await withAuth(getAuth, providerID)
    let healed = false
    // Perch meters turns per account, and a burst of tickets is throttled
    // rather than refused outright — the CLI simply waits and tries again.
    // A throttled ticket is not fatal: back off, drop the cached ticket and
    // mint a new one instead of surfacing the 429 to the client.
    let throttled = 0
    // Perch's refusals depend on what the request looks like, and the client's
    // shape is not always visible from here, so a request's outbound form can
    // be recorded. The plugin runs inside magpie, which was started long before
    // any debugging session, so setting an environment variable means
    // restarting magpie: a file in the temp directory toggles it instead, and
    // PERCHAI2API_DEBUG_DUMP overrides the destination.
    const dump = async () => {
      const marker = path.join(os.tmpdir(), "perchai2api-dump-on")
      const file = first(process.env.PERCHAI2API_DEBUG_DUMP, fs.existsSync(marker) ? path.join(os.tmpdir(), "perchai2api-model-calls.jsonl") : "")
      if (!file) return
      const line = JSON.stringify({
        at: new Date().toISOString(),
        url,
        surface: body.clientSurface ?? "cli",
        messages: (body.request?.messages ?? []).map((m) => ({ role: m.role, chars: String(m.content ?? "").length })),
        preferredModelId: body.preferredModelId ?? null,
        manualModelOptionId: body.manualModelOptionId ?? null,
        lane: body.lane ?? null,
        keys: Object.keys(body),
      })
      try {
        await fs.appendFile(file, line + "\n")
      } catch {}
    }
    for (let attempt = 0; ; attempt++) {
      await dump()
      const ticket = await ticketFor(s, app, body.runId, body.clientSurface ?? "cli", signal, { retry: attempt > 0 })
      // the ticket is minted before the body goes out, so this is the first
      // moment the workspace it names is known: fill attribution from it
      if (ticket && body.attribution && !body.attribution.workspaceId) {
        const claim = claimOf(ticket)
        body.attribution.userId = first(body.attribution.userId, claim.uid, learned.userId)
        body.attribution.workspaceId = first(claim.wid, learned.workspaceId)
      }
      if (ticket === RATE_LIMITED) {
        if (throttled >= 4 || signal?.aborted) {
          throw new PerchError(
            "Perchai: the account's Perch turn rate limit is reached; wait a moment and try again.",
            429,
            "turn_rate_limited",
          )
        }
        throttled += 1
        tickets.clear()
        await sleep(1200 * 2 ** (throttled - 1))
        continue
      }
      const headers = cliHeaders({
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.access}`,
        ...(ticket ? { "x-perch-turn-ticket": ticket } : {}),
      })
      let res
      try {
        res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal })
      } catch (e) {
        if (e?.name === "AbortError") throw e
        if (attempt >= 2) throw new PerchError(`Perchai: ${e?.message ?? String(e)}`, 502, "api_error")
        await sleep(350 * 2 ** attempt)
        continue
      }
      if (res.status === 401 && !healed) {
        healed = true
        tickets.clear()
        // a session with no refresh token has no way back: leave the 401
        // as Perch sent it rather than throwing over the top of it
        if (!s.refreshToken) return res
        try {
          s = await withAuth(getAuth, providerID, { force: true })
        } catch {
          return res
        }
        continue
      }
      if ([408, 425, 500, 502, 503, 504].includes(res.status) && attempt < 2) {
        await res.body?.cancel?.()
        await sleep(350 * 2 ** attempt)
        continue
      }
      return res
    }
  }

  // run is one model-call turned into an OpenAI stream, or into one body.
  const run = async (input, init, { getAuth, providerID } = {}) => {
    const text = init?.body == null ? "{}" : typeof init.body === "string" ? init.body : await new Response(init.body).text()
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return explain(400, "the request body is not JSON", "invalid_request_error")
    }
    const req = bodyOf(json)
    const model = first(req.wanted) || "auto"
    const surface = first(process.env.PERCH_CLI_SURFACE, "cli")
    const option = optionOf(req.wanted)
    // Perch's own envelope. runId ties this call's turn ticket, stream and
    // telemetry together; the CLI makes one per turn and shapes it
    // tkt-cli-<epochMs>-<random>, which the proxy recognises as a CLI run.
    const runId = `tkt-cli-${Date.now()}-${crypto.randomUUID().slice(0, 8).replace(/-/g, "")}`
    const me = stateOf(await getAuth()) ?? {}
    const messages = withSystem(req.messages.length ? req.messages : [{ role: "user", content: "" }])
    const envelope = {
      request: {
        lane: LANES.has(json?.lane) ? json.lane : "chat",
        messages,
        ...(req.tools.length ? { tools: req.tools } : {}),
        ...(req.maxOutputTokens ? { maxOutputTokens: req.maxOutputTokens } : {}),
        ...(typeof req.temperature === "number" ? { temperature: req.temperature } : {}),
        ...(req.toolChoice ? { toolChoice: req.toolChoice } : {}),
        ...(req.responseFormat ? { responseFormat: req.responseFormat } : {}),
        ...(req.reasoning ? { reasoning: req.reasoning } : {}),
      },
      runId,
      lane: "chat",
      strictManual: false,
      raceMode: option.manual ? "single" : undefined,
      preferredModelId: option.preferred,
      avoidModelIds: [],
      // The proxy reads attribution, not a "client" label: a call without a
      // userId/workspaceId pair and source "cli" is refused as direct API
      // access no matter what clientSurface says.
      attribution: {
        userId: first(me.userId, learned.userId),
        workspaceId: first(learned.workspaceId, me.workspaceId),
        runId,
        lane: "chat",
        source: "cli",
        billingMultiplier: null,
      },
      clientSurface: surface,
      // the CLI asks the proxy to resend rather than truncate when an answer
      // would be cut off mid-stream
      resendAfterOutput: true,
      ...(option.manual ? { manualModelOptionId: option.manual } : {}),
    }
    const res = await call(getAuth, providerID, envelope, { signal: init?.signal })
    if (!res.ok) {
      const refused = await refusalOf(res)
      return explain(refused.status, refused.message, typeOf(refused.status, refused.errorCode))
    }
    const ctype = res.headers.get("content-type") ?? ""
    const id = `chatcmpl_${runId}`
    if (!req.stream) {
      const body = await readWhole(res, ctype)
      if (!body.ok) return explain(body.status, body.message, typeOf(body.status, body.errorCode))
      const message = { role: "assistant", content: body.text || null }
      if (body.reasoning) message.reasoning_content = body.reasoning
      if (body.toolCalls.length) {
        message.tool_calls = body.toolCalls.map((c) => ({
          id: c.id,
          type: "function",
          function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) },
        }))
      }
      return new Response(
        JSON.stringify({
          id,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: body.model || model,
          choices: [{ index: 0, message, finish_reason: body.toolCalls.length ? "tool_calls" : "stop" }],
          usage: body.usage,
        }),
        { headers: { "content-type": "application/json" } },
      )
    }
    return stream(res, ctype, id, model, init?.signal)
  }

  return {
    config: async (cfg) => {
      cfg.provider ??= {}
      const was = cfg.provider[PROVIDER] ?? {}
      cfg.provider[PROVIDER] = {
        name: "Perchai",
        npm: "@ai-sdk/openai-compatible",
        api: appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL) + "/api/perch-terminal",
        ...was,
        models: { ...Object.fromEntries(MANUAL.map((m) => [m.name, entryOf(m)])), ...(was.models ?? {}) },
        options: { baseURL: appOf(process.env.PERCH_CLI_APP_URL, process.env.PERCH_APP_URL) + "/api/perch-terminal", apiKey: "perchai", ...(was.options ?? {}) },
      }
    },
    provider: {
      id: PROVIDER,
      // Perch's model names are Perch's own and its proxy takes any of them,
      // so the table above is always offered; a signed-in account puts its
      // own default first, which is the one Perch would route to anyway
      async models(provider, { auth } = {}) {
        const s = stateOf(auth)
        const out = Object.fromEntries(MANUAL.map((m) => [m.name, { ...model(m), providerID: PROVIDER }]))
        if (!s) return { ...out, ...(provider?.models ?? {}) }
        const pick = await defaultModelOf(s).catch(() => "")
        if (pick) {
          const known = MANUAL.find((m) => m.name.toLowerCase() === pick.toLowerCase())
          const first = known ?? { name: pick, label: pick, context: 200_000, output: 64_000, reasoning: true, image: false }
          // re-insert the account's default at the head of the table
          const ordered = [first, ...MANUAL.filter((m) => m.name !== first.name)]
          const rest = Object.fromEntries(ordered.map((m) => [m.name, { ...model(m), providerID: PROVIDER }]))
          return { ...rest, ...out, ...(provider?.models ?? {}) }
        }
        return { ...out, ...(provider?.models ?? {}) }
      },
    },
    auth: {
      provider: PROVIDER,
      async loader(getAuth, provider) {
        const s0 = stateOf(await getAuth())
        if (!s0) return {}
        const providerID = provider?.id ?? PROVIDER
        return {
          baseURL: s0.appUrl + "/api/perch-terminal",
          apiKey: "perchai",
          async fetch(input, init) {
            return run(input, init, { getAuth, providerID })
          },
        }
      },
      async usage(getAuth, provider) {
        const s = stateOf(await getAuth())
        if (!s) return { error: "not signed in to Perchai", signIn: "kept" }
        // The allowance, not the account's metadata, is what a usage card is
        // for: Perch reports it as the PT spend against the plan's monthly
        // allowance, so read that and fall back to naming the account only
        // when Perch cannot be asked.
        const meter = await usageMeter(s).catch(() => null)
        if (meter?.expired) return { error: "Perchai's sign-in has run out; sign in again", plan: s.email || undefined, signIn: "kept" }
        try {
          const app = await appFor(s.appUrl)
          const res = await fetch(endpoint(app, "/api/perch-terminal/public-model-default"), {
            headers: cliHeaders({ Authorization: `Bearer ${s.access}` }),
          })
          const json = res.ok ? await res.json().catch(() => null) : null
          const selection = json?.selection ?? null
          const windows = meter ? perchWindows(meter) : []
          if (!windows.length) {
            windows.push(
              { name: "Account", detail: s.email || "signed in" },
              { name: "Surface", detail: "cli · model-call" },
            )
          }
          if (selection?.chatModelId) windows.push({ name: "Default model", detail: String(selection.chatModelId) })
          return { plan: meter?.plan || s.email || "Perchai", windows, signIn: "kept" }
        } catch (e) {
          return meter
            ? { plan: meter.plan || s.email || "Perchai", windows: perchWindows(meter), signIn: "kept" }
            : { error: e?.message ?? String(e), signIn: "kept" }
        }
      },
      methods: [
        {
          type: "oauth",
          label: "Perchai: sign in (Google, GitHub, or email)",
          authorize: () => signIn(log, first(process.env.PERCHAI_OAUTH_PROVIDER, "google")),
        },
        {
          // no browser window, no waiting: the session the browser already
          // holds is read from its cookie store
          type: "oauth",
          label: "Perchai: use the session this browser is already signed in with",
          authorize: () => signInFromBrowser(log),
        },
        { type: "api", label: "Perchai access token", prompts: [{ type: "text", key: "key", message: "Paste a Supabase access token from chat.perchai.app" }] },
      ],
    },
  }
}

// defaultModelOf asks Perch which model it would pick for this account. The
// CLI asks the same question before a turn, with a short timeout, and treats
// any failure as "no opinion".
async function defaultModelOf(s) {
  const app = await appFor(s.appUrl)
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 3500)
  try {
    const res = await fetch(endpoint(app, "/api/perch-terminal/public-model-default"), {
      headers: cliHeaders({ Authorization: s.access ? `Bearer ${s.access}` : "" }),
      signal: ctl.signal,
    })
    if (!res.ok) return ""
    const json = await res.json().catch(() => null)
    if (json?.ok !== true) return ""
    return first(json?.selection?.chatModelId)
  } catch {
    return ""
  } finally {
    clearTimeout(timer)
  }
}

// PT is Perch's unit of allowance: one PT is a thousandth of a dollar of
// recorded model spend, rounded up, which is why 20,000 PT is quoted as up to
// US$20. The app's own client converts the same way (ceil(usd / 0.001)).
const PT_PER_USD = 1000

function ptOf(usd) {
  const n = Number(usd)
  return Number.isFinite(n) && n > 0 ? Math.ceil(n * PT_PER_USD) : 0
}

// usageMeter asks for the allowance the Settings → Usage page shows. The page
// reads it through a Postgres function rather than an app route, so the user's
// own token is what answers; the app route answers only a browser cookie and
// refuses the CLI's.
async function usageMeter(s) {
  if (!s?.access) return null
  const dayStart = new Date()
  dayStart.setHours(0, 0, 0, 0)
  const weekStart = new Date()
  weekStart.setDate(weekStart.getDate() - 7)
  const res = await fetch(`${s.supabaseUrl}/rest/v1/rpc/perch_ai_my_inference_usage_meter`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: s.supabaseKey ?? "",
      Authorization: `Bearer ${s.access}`,
    },
    body: JSON.stringify({ p_day_start: dayStart.toISOString(), p_week_start: weekStart.toISOString() }),
  })
  if (res.status === 401 || res.status === 403) return { expired: true }
  if (!res.ok) return null
  const json = await res.json().catch(() => null)
  if (!json || typeof json !== "object") return null
  const num = (k) => {
    const n = Number(json[k])
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  return {
    // Starter's monthly allowance is 20,000 PT (up to US$20); a plan that
    // reports its own cap wins, and this is only the default the page quotes.
    plan: "Perch Starter",
    monthlyPt: ptOf(num("monthly_usd")),
    monthlyAllowancePt: 20_000,
    manualPt: ptOf(num("monthly_manual_usd")),
    dailyPt: ptOf(num("daily_usd")),
    weeklyPt: ptOf(num("weekly_usd")),
    dailyCalls: num("daily_calls"),
    weeklyCalls: num("weekly_calls"),
    monthlyCalls: num("monthly_calls"),
    weeklyTokens: num("weekly_tokens"),
    monthlyTokens: num("monthly_tokens"),
    periodStart: typeof json.period_start === "string" ? json.period_start : null,
  }
}

// perchWindows turns the meter into the row magpie's card shows. Perch reports
// the month's spend against the plan's allowance and nothing else for a plan
// without rolling windows, so that is the one row drawn: a second row would
// only be a 0% bar, which says nothing.
function perchWindows(m) {
  const cap = m.monthlyAllowancePt || 20_000
  const used = Math.max(0, m.monthlyPt - m.manualPt)
  const bits = []
  if (m.monthlyTokens > 0) bits.push(`${m.monthlyTokens.toLocaleString("en-US")} tokens`)
  if (m.monthlyCalls > 0) bits.push(`${m.monthlyCalls} turns`)
  // period_start is when the allowance began, so the reset is a month on from
  // it — the page words it as a monthly reset, not a fixed date.
  const resets = resetOf(m.periodStart)
  if (resets) bits.push(`resets ${resets}`)
  return [
    {
      name: "Perch Tokens · month",
      used: cap > 0 ? Math.min(100, (100 * used) / cap) : 0,
      amount: used,
      limit: cap,
      display: `${used} / ${cap.toLocaleString("en-US")} PT`,
      ...(bits.length ? { detail: bits.join(" · ") } : {}),
    },
  ]
}

// resetOf is the day a period that began at start rolls over, as the page
// shows it. An unreadable start yields nothing rather than a guessed date.
function resetOf(start) {
  const at = Date.parse(start ?? "")
  if (!Number.isFinite(at)) return ""
  const d = new Date(at)
  d.setMonth(d.getMonth() + 1)
  return d.toISOString().slice(0, 10)
}

// model is one model in OpenCode's shape, with Perch's reasoning and
// image abilities as the entry's own.
function model(m) {
  const e = entryOf(m)
  return {
    id: m.name,
    providerID: PROVIDER,
    name: e.name,
    api: { id: m.name, url: "", npm: "@ai-sdk/openai-compatible" },
    status: "active",
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: e.limit,
    options: {},
    headers: {},
    capabilities: {
      temperature: true,
      reasoning: e.reasoning,
      attachment: e.attachment,
      toolcall: true,
      input: { text: true, image: !!m.image, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
  }
}

// readWhole turns Perch's answer into the completion a non-stream client
// reads: the JSON body the proxy answers with, or its stream run to the end.
async function readWhole(res, ctype) {
  const text = await res.text()
  if ((ctype || "").includes("application/json")) {
    let json
    try {
      json = JSON.parse(text)
    } catch {
      return { ok: false, status: 502, errorCode: "parse_error", message: text.slice(0, 240) }
    }
    if (json?.ok === false || json?.error) {
      return { ok: false, status: 400, errorCode: first(json.errorCode, "api_error"), message: first(json.error, "Perchai refused the request") }
    }
    const msg = json?.choices?.[0]?.message ?? {}
    return {
      ok: true,
      text: first(typeof msg.content === "string" ? msg.content : "", json?.text),
      reasoning: first(msg.reasoning_content, json?.providerReasoning?.text),
      toolCalls: Array.isArray(msg.tool_calls)
        ? msg.tool_calls.map((c) => ({ id: c.id, name: c.function?.name, arguments: c.function?.arguments }))
        : Array.isArray(json?.toolCalls)
          ? json.toolCalls
          : [],
      usage: usageOf(json?.usage),
      model: first(json?.model),
    }
  }
  // a stream answered to a non-stream client: run it and keep the pieces
  let out = ""
  let thinking = ""
  const calls = new Map()
  let usage = null
  let model = ""
  for (const ev of events(text)) {
    if (ev.type === "text_delta" && ev.text) out += ev.text
    else if (ev.type === "reasoning_delta" && ev.text) thinking += ev.text
    else if (ev.type === "tool_call_delta" && ev.toolCalls) collect(calls, ev.toolCalls)
    else if (ev.type === "tool_use_end" && Array.isArray(ev.toolCalls)) {
      calls.clear()
      collect(calls, ev.toolCalls)
    } else if (ev.type === "stream_restart") {
      out = ""
      thinking = ""
      calls.clear()
    } else if (ev.type === "done") {
      if (typeof ev.text === "string") out = ev.text
      if (ev.providerReasoning?.text) thinking = ev.providerReasoning.text
      if (Array.isArray(ev.toolCalls)) {
        calls.clear()
        collect(calls, ev.toolCalls)
      }
      usage = usageOf(ev.usage)
      model = first(ev.model)
    } else if (ev.error) {
      return { ok: false, status: 502, errorCode: first(ev.error.code, "api_error"), message: first(ev.error.message, "Perchai's stream failed") }
    }
  }
  return { ok: true, text: out, reasoning: thinking, toolCalls: [...calls.values()], usage, model }
}

// events reads Perch's SSE body into the event objects it carries.
function* events(text) {
  for (const line of text.split("\n")) {
    const t = line.trim()
    if (!t.startsWith("data:")) continue
    const body = t.slice(5).trim()
    if (!body || body === "[DONE]") continue
    try {
      yield JSON.parse(body)
    } catch {}
  }
}

// collect keeps tool calls by index, as their deltas arrive.
function collect(kept, incoming) {
  for (const c of Array.isArray(incoming) ? incoming : []) {
    if (!c || typeof c !== "object") continue
    const key = Number.isFinite(c.index) ? c.index : c.id ?? kept.size
    const prev = kept.get(key) ?? { id: "", name: "", arguments: "" }
    const args = typeof c.function?.arguments === "string" ? c.function.arguments : c.arguments
    kept.set(key, {
      id: first(c.id, prev.id) || `call_${crypto.randomBytes(6).toString("hex")}`,
      name: first(c.function?.name, c.name, prev.name),
      arguments: typeof args === "string" ? (c.index === undefined && !c.delta ? args : prev.arguments + args) : prev.arguments,
    })
  }
}

function usageOf(u) {
  if (!u || typeof u !== "object") return undefined
  const prompt = Number(u.prompt_tokens ?? u.input_tokens ?? u.inputTokens ?? 0) || 0
  const completion = Number(u.completion_tokens ?? u.output_tokens ?? u.outputTokens ?? 0) || 0
  if (!prompt && !completion) return undefined
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: prompt + completion }
}

// stream turns Perch's event stream into OpenAI chunks as it arrives.
function stream(res, ctype, id, modelName, signal) {
  const enc = new TextEncoder()
  let reader = null
  let timer = null
  const body = new ReadableStream({
    async start(controller) {
      const send = (s) => controller.enqueue(enc.encode(s))
      const calls = new Map()
      let usage = null
      let done = null
      let thought = false
      try {
        if ((ctype || "").includes("application/json")) {
          // a proxy that answered in one piece instead of streaming
          const whole = await readWhole(res, ctype)
          if (!whole.ok) {
            send(`data: ${JSON.stringify({ error: { type: typeOf(whole.status, whole.errorCode), message: whole.message, code: whole.errorCode } })}\n\n`)
            send("data: [DONE]\n\n")
            controller.close()
            return
          }
          send(chunk(id, whole.model || modelName, { role: "assistant", content: whole.text || "" }))
          for (const c of whole.toolCalls) {
            send(chunk(id, modelName, { tool_calls: [{ index: [...calls.keys()].length, id: c.id, type: "function", function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } }] }))
          }
          send(chunk(id, modelName, {}, whole.toolCalls.length ? "tool_calls" : "stop"))
          send("data: [DONE]\n\n")
          controller.close()
          return
        }
        reader = res.body.getReader()
        const dec = new TextDecoder()
        let buffer = ""
        timer = setTimeout(() => {
          try {
            controller.error(new Error("Perchai's stream stopped sending"))
          } catch {}
        }, STREAM_TIMEOUT_MS)
        send(chunk(id, modelName, { role: "assistant", content: "" }))
        for (;;) {
          const { done: end, value } = await reader.read()
          if (end) break
          buffer += dec.decode(value, { stream: true })
          const lines = buffer.split("\n")
          buffer = lines.pop() ?? ""
          for (const line of lines) {
            const t = line.trim()
            if (!t.startsWith("data:")) continue
            const raw = t.slice(5).trim()
            if (!raw || raw === "[DONE]") continue
            let ev
            try {
              ev = JSON.parse(raw)
            } catch {
              continue
            }
            if (ev.error) {
              const e = typeof ev.error === "object" ? ev.error : { message: String(ev.error) }
              send(`data: ${JSON.stringify({ error: { type: typeOf(Number(e.code) || 502, first(e.errorCode)), message: first(e.message, "Perchai's stream failed"), code: first(e.errorCode, e.code) } })}\n\n`)
              send("data: [DONE]\n\n")
              await reader.cancel().catch(() => {})
              controller.close()
              return
            }
            if (ev.type === "text_delta" && ev.text) send(chunk(id, modelName, { content: ev.text }))
            else if (ev.type === "reasoning_delta" && ev.text) {
              thought = true
              send(chunk(id, modelName, { reasoning_content: ev.text }))
            } else if (ev.type === "tool_call_delta" && ev.toolCalls) {
              const before = new Map(calls)
              collect(calls, ev.toolCalls)
              let i = 0
              for (const [key, c] of calls) {
                const was = before.get(key)
                if (was && was.arguments === c.arguments && was.name === c.name) {
                  i++
                  continue
                }
                send(
                  chunk(id, modelName, {
                    tool_calls: [
                      {
                        index: i,
                        ...(was ? {} : { id: c.id, type: "function", function: { name: c.name, arguments: "" } }),
                        ...(was && c.arguments !== was.arguments ? { function: { arguments: c.arguments.slice(was.arguments.length) } } : {}),
                      },
                    ],
                  }),
                )
                i++
              }
            } else if (ev.type === "tool_use_end" && Array.isArray(ev.toolCalls)) {
              calls.clear()
              const before = new Map()
              collect(calls, ev.toolCalls.map((c, i) => ({ ...c, index: i })))
              let i = 0
              for (const [, c] of calls) {
                send(
                  chunk(id, modelName, {
                    tool_calls: [{ index: i, id: c.id, type: "function", function: { name: c.name, arguments: typeof c.arguments === "string" ? c.arguments : JSON.stringify(c.arguments ?? {}) } }],
                  }),
                )
                i++
              }
            } else if (ev.type === "stream_restart") {
              calls.clear()
              if (thought) {
                thought = false
                send(chunk(id, modelName, { reasoning_content: "" }))
              }
            } else if (ev.type === "done") {
              done = ev
              usage = usageOf(ev.usage)
              // Perch's own text is authoritative for the final answer; the
              // deltas above carried it, so nothing is re-sent here
            }
          }
        }
        clearTimeout(timer)
        if (usage) {
          send(
            `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: modelName, choices: [], usage })}\n\n`,
          )
        }
        const finish = calls.size || done?.toolCalls?.length ? "tool_calls" : "stop"
        send(chunk(id, modelName, {}, finish))
        send("data: [DONE]\n\n")
        controller.close()
      } catch (e) {
        clearTimeout(timer)
        try {
          send(`data: ${JSON.stringify({ error: { type: "api_error", message: e?.message ?? String(e) } })}\n\n`)
          send("data: [DONE]\n\n")
        } catch {}
        try {
          controller.close()
        } catch {}
        reader?.cancel?.().catch?.(() => {})
      }
    },
    cancel(reason) {
      clearTimeout(timer)
      reader?.cancel?.(reason).catch?.(() => {})
    },
  })
  return new Response(body, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}

// for tests
export const _internal = {
  PROVIDER,
  MANUAL,
  MODELS,
  appOf,
  endpoint,
  stateOf,
  fresh,
  oauthStart,
  verifierOf,
  sessionOf,
  sbAuth,
  signIn,
  signInFromBrowser,
  browserStores,
  cookieParts,
  sessionFromCookie,
  harvestSession,
  sessionToAuth,
  withSystem,
  renewed,
  modelCallURL,
  bodyOf,
  optionOf,
  ticketFor,
  refusalOf,
  readWhole,
  events,
  collect,
  usageOf,
  usageMeter,
  perchWindows,
  ptOf,
  slug,
  entryOf,
  PROMPT,
}
