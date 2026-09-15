import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RemainingRow, UsageSnapshot } from "../shared/usage";
import { discoverCredentials, fetchWithCredentials, readJson } from "./credentials.ts";

const execFileAsync = promisify(execFile);
const home = homedir();

// One slow provider must not stall the whole usage RPC (the pill then shows
// "Usage…" for every provider). Each request gets its own deadline.
const FETCH_TIMEOUT_MS = 15_000;
async function fetchWithTimeout(url: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const body = await response.arrayBuffer();
    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } finally {
    clearTimeout(timer);
  }
}

type Tone = RemainingRow["tone"];
type Brand = RemainingRow["brand"];
type Group = RemainingRow["group"];

function remainingFromUsed(usedPct: number | null | undefined): number | null {
  if (typeof usedPct !== "number" || Number.isNaN(usedPct)) return null;
  return Math.max(0, Math.min(100, Math.round(100 - usedPct)));
}

function toneFromRemaining(remainingPct: number | null): Tone {
  if (remainingPct == null) return "default";
  if (remainingPct > 50) return "ok";
  if (remainingPct > 20) return "warning";
  return "danger";
}

function pctText(remainingPct: number | null): string {
  return remainingPct == null ? "—" : `${remainingPct}%`;
}

function resetLabel(iso: string | null | undefined, now: number = Date.now()): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const delta = date.getTime() - now;
  if (delta <= 0) return "now";
  const totalMinutes = Math.max(1, Math.floor(delta / 60_000));
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 1) return `${totalMinutes}m`;
  if (totalHours < 24) {
    const remMinutes = totalMinutes % 60;
    return remMinutes === 0 ? `${totalHours}h` : `${totalHours}h ${remMinutes}m`;
  }
  const days = Math.floor(totalHours / 24);
  const remHours = totalHours % 24;
  if (days >= 3 || remHours === 0) return `${days}d`;
  return `${days}d ${remHours}h`;
}

function baseRow(id: string, brand: Brand, group: Group, label: string): RemainingRow {
  return {
    id,
    brand,
    group,
    label,
    remainingText: "—",
    remainingPct: null,
    resetAt: null,
    resetIso: null,
    detail: "Not signed in or no usage data",
    tone: "default",
    status: "unavailable",
  };
}

function row(
  id: string,
  brand: Brand,
  group: Group,
  label: string,
  remainingPct: number | null,
  resetIso: string | null | undefined,
  detail: string | null = null,
): RemainingRow {
  return {
    id,
    brand,
    group,
    label,
    remainingText: pctText(remainingPct),
    remainingPct,
    resetAt: resetLabel(resetIso),
    resetIso: resetIso ?? null,
    detail,
    tone: toneFromRemaining(remainingPct),
    status: remainingPct == null ? "unavailable" : "available",
  };
}

function credentialDetail(rows: RemainingRow[], detail: string): RemainingRow[] {
  return rows.map((item) => ({
    ...item,
    detail: item.detail ? `${item.detail} · ${detail}` : detail,
  }));
}

// Anthropic's usage endpoint answers 429 (retry-after ~1 h) for tokens it will not
// serve: expired access tokens and long-lived setup tokens. A fresh keychain token
// from an interactive Claude Code login answers 200. So: never call with an expired
// token, prefer keychain/file tokens over the env setup token, and keep a per-token
// cooldown (persisted across reloads) so a rejected token is not retried for an hour.
const claudeTokenCooldownUntil = new Map<string, number>();
let lastClaudeRows: RemainingRow[] | null = null;
let lastClaudeAt = 0;
const CLAUDE_MIN_INTERVAL_MS = 5 * 60_000;
const CLAUDE_DEFAULT_COOLDOWN_MS = 60 * 60_000;

function tokenKey(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 16);
}

type ClaudeCredential = { token: string; expiresAt: number | null; source: "keychain" | "file" | "env" };

async function readClaudeEnvToken(): Promise<string | undefined> {
  if (process.env.CLAUDE_CODE_OAUTH_TOKEN) return process.env.CLAUDE_CODE_OAUTH_TOKEN;
  // Optional env files some setups use to hand Claude a long-lived token.
  for (const path of [
    join(home, ".config", "agent-core", "auth", "claude.env"),
    join(home, ".claude", "claude.env"),
  ]) {
    try {
      const env = await readFile(path, "utf8");
      const token = env.match(/CLAUDE_CODE_OAUTH_TOKEN=["']?([^"'\n]+)/)?.[1];
      if (token) return token;
    } catch {
      // keep looking
    }
  }
  return undefined;
}

function parseClaudeCredential(raw: unknown, source: ClaudeCredential["source"]): ClaudeCredential | null {
  const oauth = (raw as { claudeAiOauth?: { accessToken?: string; expiresAt?: number } } | null)?.claudeAiOauth;
  if (!oauth?.accessToken) return null;
  return { token: oauth.accessToken, expiresAt: typeof oauth.expiresAt === "number" ? oauth.expiresAt : null, source };
}

async function readClaudeCredentials(): Promise<ClaudeCredential[]> {
  const found: ClaudeCredential[] = [];
  const seen = new Set<string>();
  const add = (cred: ClaudeCredential | null) => {
    if (cred && !seen.has(cred.token)) {
      seen.add(cred.token);
      found.push(cred);
    }
  };
  const account = /^[a-zA-Z0-9._-]+$/.test(process.env.USER || userInfo().username)
    ? process.env.USER || userInfo().username
    : "claude-code-user";
  for (const args of [
    ["find-generic-password", "-a", account, "-w", "-s", "Claude Code-credentials"],
    ["find-generic-password", "-w", "-s", "Claude Code-credentials"],
  ]) {
    try {
      const { stdout } = await execFileAsync("security", args, { timeout: 2000 });
      add(parseClaudeCredential(JSON.parse(stdout.trim()), "keychain"));
    } catch {
      // keep looking
    }
  }
  add(parseClaudeCredential(await readJson(join(process.env.CLAUDE_HOME || join(home, ".claude"), ".credentials.json")), "file"));
  // Paseo agents authenticate through this long-lived token; keep it as the last resort.
  const envToken = await readClaudeEnvToken();
  if (envToken) add({ token: envToken, expiresAt: null, source: "env" });
  return found;
}

async function fetchClaude(): Promise<RemainingRow[]> {
  const now = Date.now();
  const fallback = [
    baseRow("claude_session", "claude", "session", "Claude"),
    baseRow("claude_week", "claude", "weekly", "Claude"),
    baseRow("fable_week", "fable", "weekly", "Fable"),
  ];
  const rowsStillValid = lastClaudeRows != null && !lastClaudeRows.some((r) => cachedWindowHasReset(r, now));
  // The minimum interval applies to manual refreshes too: the endpoint blocks the
  // whole account for an hour when it is polled too often.
  if (rowsStillValid && now - lastClaudeAt < CLAUDE_MIN_INTERVAL_MS) return lastClaudeRows!;

  const creds = await readClaudeCredentials();
  const tokens = creds
    .filter((cred) => cred.expiresAt == null || cred.expiresAt > now + 30_000)
    .map((cred) => cred.token)
    .filter((token) => (claudeTokenCooldownUntil.get(tokenKey(token)) ?? 0) <= now);
  if (tokens.length === 0) {
    console.log(`[usage-remaining] claude: no usable token (${creds.length} found, all expired or cooling down)`);
    return rowsStillValid ? lastClaudeRows! : fallback;
  }

  type ClaudeUsageBody = {
    five_hour?: { utilization?: number; resets_at?: string | null };
    seven_day?: { utilization?: number; resets_at?: string | null };
    seven_day_omelette?: { utilization?: number; resets_at?: string | null };
    limits?: Array<{
      kind?: string;
      percent?: number;
      resets_at?: string | null;
      scope?: { model?: { display_name?: string | null; id?: string | null } | null };
    }>;
  };
  let body: ClaudeUsageBody | null = null;
  for (const token of tokens) {
    const res = await fetchWithTimeout("https://api.anthropic.com/api/oauth/usage", {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "anthropic-beta": "oauth-2025-04-20",
      },
    });
    const source = creds.find((c) => c.token === token)?.source ?? "?";
    if (res.status === 401 || res.status === 403) {
      console.log(`[usage-remaining] claude: ${res.status} from ${source} token`);
      continue;
    }
    if (res.status === 429) {
      const retryAfter = Number(res.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : CLAUDE_DEFAULT_COOLDOWN_MS;
      claudeTokenCooldownUntil.set(tokenKey(token), now + waitMs);
      saveCache();
      console.log(`[usage-remaining] claude: 429 from ${source} token, cooling down ${Math.round(waitMs / 60_000)}m`);
      continue;
    }
    if (!res.ok) {
      console.log(`[usage-remaining] claude: ${res.status} from ${source} token`);
      continue;
    }
    console.log(`[usage-remaining] claude: ok via ${source} token`);
    body = (await res.json()) as ClaudeUsageBody;
    break;
  }
  if (!body) return fallback;

  const fableLimit = body.limits?.find((entry) => {
    if (entry.kind !== "weekly_scoped") return false;
    const name = `${entry.scope?.model?.display_name ?? ""} ${entry.scope?.model?.id ?? ""}`.toLowerCase();
    return name.includes("fable") || name.includes("omelette");
  });
  const fableUsed = fableLimit?.percent ?? body.seven_day_omelette?.utilization;
  const fableReset = fableLimit?.resets_at ?? body.seven_day_omelette?.resets_at ?? body.seven_day?.resets_at;

  const rows = [
    row("claude_session", "claude", "session", "Claude", remainingFromUsed(body.five_hour?.utilization), body.five_hour?.resets_at),
    row("claude_week", "claude", "weekly", "Claude", remainingFromUsed(body.seven_day?.utilization), body.seven_day?.resets_at),
    row("fable_week", "fable", "weekly", "Fable", remainingFromUsed(fableUsed), fableReset),
  ];
  lastClaudeRows = rows;
  lastClaudeAt = Date.now();
  saveCache();
  return rows;
}

async function fetchCodex(): Promise<RemainingRow[]> {
  const fallback = [
    baseRow("codex_session", "codex", "session", "Codex"),
    baseRow("codex_week", "codex", "weekly", "Codex"),
  ];
  const result = await fetchWithCredentials("codex", await discoverCredentials("codex"), (credential) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${credential.secret}`,
      Accept: "application/json",
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
    };
    if (credential.accountId) headers["ChatGPT-Account-Id"] = credential.accountId;
    return fetchWithTimeout("https://chatgpt.com/backend-api/wham/usage", { headers });
  });
  const res = result.response;
  if (!res) return credentialDetail(fallback, result.detail);
  if (!res.ok) return credentialDetail(fallback, `${result.detail} · Query failed (${res.status})`);
  const text = await res.text();
  if (text.trim().startsWith("<")) return fallback;
  type CodexWindow = { used_percent?: number; reset_at?: number; limit_window_seconds?: number };
  const body = JSON.parse(text) as {
    rate_limit?: {
      primary_window?: CodexWindow | null;
      secondary_window?: CodexWindow | null;
    };
  };
  const primary = body.rate_limit?.primary_window;
  const secondary = body.rate_limit?.secondary_window;
  const toIso = (epoch: number | undefined) => (epoch != null ? new Date(epoch * 1000).toISOString() : null);
  // Codex window semantics vary by plan; classify by window length when the API
  // reports it, else by reset horizon.
  const windows = [primary, secondary].filter((w): w is CodexWindow => w != null);
  const rows: RemainingRow[] = [];
  for (const w of windows) {
    const iso = toIso(w.reset_at);
    let isSession: boolean;
    if (typeof w.limit_window_seconds === "number") {
      isSession = w.limit_window_seconds <= 6 * 3600;
    } else {
      const hours = iso ? (new Date(iso).getTime() - Date.now()) / 3_600_000 : null;
      isSession = hours != null && hours <= 10;
    }
    const group: Group = isSession ? "session" : "weekly";
    const id = isSession ? "codex_session" : "codex_week";
    if (rows.some((r) => r.id === id)) continue;
    rows.push(row(id, "codex", group, "Codex", remainingFromUsed(w.used_percent), iso));
  }
  if (rows.length === 0) return credentialDetail(fallback, result.detail);
  // Some plans (e.g. Pro as of 2026-09) have only a weekly window; do not invent
  // a session row the endpoint did not report.
  if (!rows.some((r) => r.id === "codex_session")) {
    rows.unshift({ ...baseRow("codex_session", "codex", "session", "Codex"), detail: "Session limit is not available on this plan" });
  }
  return credentialDetail(rows, result.detail);
}

export type GrokBillingBody = {
  config?: {
    monthlyLimit?: { val?: number };
    used?: { val?: number };
    creditUsagePercent?: number;
    currentPeriod?: { type?: string; start?: string; end?: string };
    billingPeriodEnd?: string;
  };
  usage?: { creditUsage?: number };
};

// xAI serialises this body from protobuf: fields at their default value are
// omitted. Right after the weekly reset `creditUsagePercent` is 0 and therefore
// missing, while `currentPeriod` is still present. Treating that as "no data"
// made the Grok row vanish for the whole first hours of every period
// (observed 2026-09-13 after the 18:57 UTC reset). A live period with no usage
// fields means 0 used.
export function parseGrokBilling(body: GrokBillingBody | null | undefined): RemainingRow {
  const config = body?.config;
  if (!config || typeof config !== "object") return baseRow("grok_week", "grok", "weekly", "Grok");
  const periodEnd = config.currentPeriod?.end ?? config.billingPeriodEnd ?? null;
  const usedPct = config.creditUsagePercent;
  if (typeof usedPct === "number" && Number.isFinite(usedPct)) {
    return row("grok_week", "grok", "weekly", "Grok", remainingFromUsed(usedPct), periodEnd);
  }
  const limit = config.monthlyLimit?.val ?? null;
  const used = config.used?.val ?? body?.usage?.creditUsage ?? null;
  if (limit != null && limit > 0 && used != null) {
    return row(
      "grok_week",
      "grok",
      "weekly",
      "Grok",
      remainingFromUsed((used / limit) * 100),
      periodEnd,
      `of ${Math.round(limit)} credits`,
    );
  }
  if (periodEnd) {
    return row("grok_week", "grok", "weekly", "Grok", 100, periodEnd, "no usage yet this period");
  }
  return baseRow("grok_week", "grok", "weekly", "Grok");
}

async function fetchGrok(): Promise<RemainingRow> {
  const fallback = baseRow("grok_week", "grok", "weekly", "Grok");
  const result = await fetchWithCredentials("grok", await discoverCredentials("grok"), (credential) =>
    fetchWithTimeout("https://cli-chat-proxy.grok.com/v1/billing?format=credits", {
      headers: {
        Authorization: `Bearer ${credential.secret}`,
        "X-XAI-Token-Auth": "xai-grok-cli",
        Accept: "application/json",
      },
    }),
  );
  const res = result.response;
  if (!res) {
    console.log(`[usage-remaining] grok: ${result.detail}`);
    return credentialDetail([fallback], result.detail)[0];
  }
  if (!res.ok) {
    console.log(`[usage-remaining] grok: ${res.status} from billing endpoint via ${result.credential?.sourceLabel}`);
    return credentialDetail([fallback], `${result.detail} · Query failed (${res.status})`)[0];
  }
  const parsed = parseGrokBilling((await res.json()) as GrokBillingBody);
  if (parsed.status !== "available") {
    console.log("[usage-remaining] grok: 200 but no usage fields in body (unrecognised shape)");
  }
  return credentialDetail([parsed], result.detail)[0];
}

async function readCursorToken(): Promise<string | null> {
  if (process.env.CURSOR_ACCESS_TOKEN) return process.env.CURSOR_ACCESS_TOKEN;
  if (process.env.CURSOR_TOKEN) return process.env.CURSOR_TOKEN;
  const dbPaths = [
    join(home, "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb"),
    join(home, ".config", "Cursor", "User", "globalStorage", "state.vscdb"),
  ];
  try {
    const sqlite = (await import("node:sqlite")) as {
      DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => {
        prepare(sql: string): { get(...params: unknown[]): Record<string, unknown> | undefined };
        close(): void;
      };
    };
    for (const path of dbPaths) {
      if (!existsSync(path)) continue;
      let db: InstanceType<typeof sqlite.DatabaseSync> | undefined;
      try {
        db = new sqlite.DatabaseSync(path, { readOnly: true });
        const modern = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuth/accessToken");
        const modernValue = modern?.value;
        if (typeof modernValue === "string" && modernValue.trim()) return modernValue.trim();
        const legacy = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get("cursorAuthStatus");
        if (typeof legacy?.value === "string") {
          const parsed = JSON.parse(legacy.value) as { accessToken?: string };
          if (parsed.accessToken) return parsed.accessToken;
        }
      } finally {
        db?.close();
      }
    }
  } catch {
    // node:sqlite missing or db locked
  }
  for (const path of [join(home, ".cursor", "auth.json"), join(home, ".config", "cursor", "auth.json")]) {
    const auth = await readJson(path);
    const token = (auth as { accessToken?: string } | null)?.accessToken?.trim();
    if (token) return token;
  }
  return null;
}

async function fetchCursor(): Promise<RemainingRow> {
  const token = await readCursorToken();
  if (!token) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  const res = await fetchWithTimeout("https://api2.cursor.sh/aiserver.v1.DashboardService/GetCurrentPeriodUsage", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
    },
    body: JSON.stringify({}),
  });
  if (!res.ok) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  const body = (await res.json()) as {
    planUsage?: {
      totalSpend?: number | null;
      limit?: number | null;
      totalPercentUsed?: number | null;
    };
    billingCycleEnd?: string | number | null;
  };
  if (!body.planUsage) return baseRow("cursor_month", "cursor", "weekly", "Cursor");
  let resetIso: string | null = null;
  if (body.billingCycleEnd != null) {
    const numeric = Number(body.billingCycleEnd);
    if (Number.isFinite(numeric)) {
      const ms = Math.abs(numeric) < 10_000_000_000 ? numeric * 1000 : numeric;
      resetIso = new Date(ms).toISOString();
    } else if (typeof body.billingCycleEnd === "string") {
      resetIso = body.billingCycleEnd;
    }
  }
  const usedPct =
    typeof body.planUsage.totalPercentUsed === "number"
      ? body.planUsage.totalPercentUsed
      : body.planUsage.totalSpend != null && body.planUsage.limit
        ? (body.planUsage.totalSpend / body.planUsage.limit) * 100
        : null;
  const detail =
    body.planUsage.totalSpend != null && body.planUsage.limit != null
      ? `used $${Math.round(body.planUsage.totalSpend / 100)} · included $${Math.round(body.planUsage.limit / 100)} · monthly`
      : "monthly";
  return row("cursor_month", "cursor", "weekly", "Cursor", remainingFromUsed(usedPct), resetIso, detail);
}

type KimiUsageRow = {
  name?: string;
  window?: { duration?: number; unit?: string };
  used?: number;
  limit?: number;
  reset_at?: string;
  resetTime?: string;
};

function parseKimiRow(raw: KimiUsageRow, id: string, group: Group, label: string): RemainingRow {
  const used = Number(raw.used);
  const limit = Number(raw.limit);
  const usedPct = Number.isFinite(used) && Number.isFinite(limit) && limit > 0 ? (used / limit) * 100 : null;
  return row(id, "kimi", group, label, remainingFromUsed(usedPct), raw.reset_at ?? raw.resetTime);
}

export function parseKimiUsage(body: unknown): RemainingRow[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const payload = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  if (payload.kind === "error") return [];
  const candidates: KimiUsageRow[] = [];
  if (payload.summary && typeof payload.summary === "object") candidates.push(payload.summary as KimiUsageRow);
  if (payload.usage && typeof payload.usage === "object") candidates.push(payload.usage as KimiUsageRow);
  if (Array.isArray(payload.limits)) {
    for (const item of payload.limits) {
      if (!item || typeof item !== "object") continue;
      const record = item as Record<string, unknown>;
      const detail = record.detail && typeof record.detail === "object" ? record.detail as KimiUsageRow : record as KimiUsageRow;
      candidates.push({
        ...detail,
        name: typeof record.name === "string" ? record.name : detail.name,
        window: record.window && typeof record.window === "object" ? record.window as KimiUsageRow["window"] : detail.window,
      });
    }
  }
  const result = new Map<Group, RemainingRow>();
  for (const candidate of candidates) {
    const duration = Number(candidate.window?.duration);
    const unit = candidate.window?.unit?.toLowerCase().replace("time_unit_", "");
    const hours = unit === "minute" ? duration / 60 : unit === "hour" ? duration : unit === "day" ? duration * 24 : unit === "week" ? duration * 168 : null;
    const group: Group = hours != null && hours <= 6 ? "session" : "weekly";
    if (!result.has(group)) {
      const suffix = group === "session" ? "session" : "week";
      result.set(group, parseKimiRow(candidate, `kimi_${suffix}`, group, "Kimi"));
    }
  }
  const wallet = payload.extra_usage && typeof payload.extra_usage === "object"
    ? payload.extra_usage as Record<string, unknown>
    : payload.boosterWallet && typeof payload.boosterWallet === "object"
      ? payload.boosterWallet as Record<string, unknown>
      : null;
  const wireBalanceCents = Number(wallet?.balance_cents);
  const rawBalance = wallet?.balance && typeof wallet.balance === "object" ? wallet.balance as Record<string, unknown> : null;
  const rawAmountLeft = Number(rawBalance?.amountLeft);
  const balanceCents = Number.isFinite(wireBalanceCents)
    ? wireBalanceCents
    : Number.isFinite(rawAmountLeft) ? Math.round(rawAmountLeft / 1_000_000) : Number.NaN;
  if (Number.isFinite(balanceCents)) {
    const rawMonthlyLimit = wallet?.monthlyChargeLimit && typeof wallet.monthlyChargeLimit === "object"
      ? wallet.monthlyChargeLimit as Record<string, unknown>
      : null;
    const currency = typeof wallet?.currency === "string" && wallet.currency
      ? wallet.currency
      : typeof rawMonthlyLimit?.currency === "string" && rawMonthlyLimit.currency ? rawMonthlyLimit.currency : "CNY";
    result.set("balance", {
      ...baseRow("kimi_balance", "kimi", "balance", "Kimi"),
      remainingText: `${currency} ${(balanceCents / 100).toFixed(2)}`,
      detail: "extra usage balance",
      status: "available",
    });
  }
  return [...result.values()].filter((item) => item.status === "available");
}

async function fetchKimi(): Promise<RemainingRow[]> {
  const fallback = [
    baseRow("kimi_session", "kimi", "session", "Kimi"),
    baseRow("kimi_week", "kimi", "weekly", "Kimi"),
  ];
  const result = await fetchWithCredentials("kimi", await discoverCredentials("kimi"), (credential) =>
    fetchWithTimeout("https://api.kimi.com/coding/v1/usages", {
      headers: { Authorization: `Bearer ${credential.secret}`, Accept: "application/json" },
    }),
  );
  const res = result.response;
  if (!res) return credentialDetail(fallback, result.detail);
  if (!res.ok) {
    console.log(`[usage-remaining] kimi: ${res.status} from usage endpoint via ${result.credential?.sourceLabel}`);
    return credentialDetail(fallback, `${result.detail} · Query failed (${res.status})`);
  }
  const parsed = parseKimiUsage(await res.json());
  return credentialDetail(parsed.length > 0 ? parsed : fallback, result.detail);
}

type GlmLimit = {
  type?: string;
  unit?: number;
  number?: number;
  percentage?: number;
  nextResetTime?: number | string;
};

export function parseGlmLimits(body: unknown): RemainingRow[] {
  if (!body || typeof body !== "object") return [];
  const root = body as Record<string, unknown>;
  const payload = (root.data && typeof root.data === "object" ? root.data : root) as Record<string, unknown>;
  if (!Array.isArray(payload.limits)) return [];
  const rows: RemainingRow[] = [];
  for (const raw of payload.limits as GlmLimit[]) {
    const type = raw.type;
    if (type !== "TOKENS_LIMIT" && type !== "CREDIT_LIMIT" && type !== "TIME_LIMIT") continue;
    const usedPct = typeof raw.percentage === "number" ? raw.percentage : null;
    let resetIso: string | null = null;
    if (raw.nextResetTime != null) {
      const numeric = Number(raw.nextResetTime);
      if (Number.isFinite(numeric)) resetIso = new Date(numeric < 10_000_000_000 ? numeric * 1000 : numeric).toISOString();
    }
    const session = raw.unit === 3 && (raw.number ?? 5) <= 6;
    const group: Group = session ? "session" : "weekly";
    const suffix = type === "TIME_LIMIT" ? "mcp" : session ? "session" : "week";
    const label = type === "TIME_LIMIT" ? "GLM MCP" : "GLM";
    rows.push(row(`glm_${suffix}`, "glm", group, label, remainingFromUsed(usedPct), resetIso));
  }
  return rows;
}

async function fetchGlm(): Promise<RemainingRow[]> {
  const fallback = [
    baseRow("glm_session", "glm", "session", "GLM"),
    baseRow("glm_mcp", "glm", "weekly", "GLM MCP"),
  ];
  const result = await fetchWithCredentials("glm", await discoverCredentials("glm"), async (credential) => {
    const china = credential.providerId === "zai-coding-cn"
      || credential.providerId === "zai-coding-plan-cn"
      || credential.providerId === "glm"
      || credential.providerId === "zhipu"
      || (!credential.providerId && process.env.ANTHROPIC_BASE_URL?.includes("bigmodel"));
    const origin = china ? "https://open.bigmodel.cn" : "https://api.z.ai";
    let response = await fetchWithTimeout(`${origin}/api/monitor/usage/quota/limit`, {
      headers: { Authorization: credential.secret, Accept: "application/json" },
    });
    if (response.status === 401 || response.status === 403) {
      response = await fetchWithTimeout(`${origin}/api/monitor/usage/quota/limit`, {
        headers: { Authorization: `Bearer ${credential.secret}`, Accept: "application/json" },
      });
    }
    return response;
  });
  const res = result.response;
  if (!res) return credentialDetail(fallback, result.detail);
  if (!res.ok) {
    console.log(`[usage-remaining] glm: ${res.status} from quota endpoint via ${result.credential?.sourceLabel}`);
    return credentialDetail(fallback, `${result.detail} · Query failed (${res.status})`);
  }
  const parsed = parseGlmLimits(await res.json());
  return credentialDetail(parsed.length > 0 ? parsed : fallback, result.detail);
}

export function parseDeepSeekBalance(body: unknown): RemainingRow[] {
  if (!body || typeof body !== "object") return [];
  const infos = (body as { balance_infos?: unknown }).balance_infos;
  if (!Array.isArray(infos)) return [];
  return infos.flatMap((raw, index) => {
    if (!raw || typeof raw !== "object") return [];
    const info = raw as { currency?: string; total_balance?: string | number };
    const amount = Number(info.total_balance);
    if (!Number.isFinite(amount)) return [];
    const currency = info.currency || "CNY";
    return [{
      ...baseRow(`deepseek_balance_${currency.toLowerCase()}_${index}`, "deepseek", "balance", "DeepSeek"),
      remainingText: `${currency} ${amount.toFixed(2)}`,
      detail: "API account balance",
      status: "available" as const,
    }];
  });
}

async function fetchDeepSeek(): Promise<RemainingRow[]> {
  const fallback = [baseRow("deepseek_balance", "deepseek", "balance", "DeepSeek")];
  const result = await fetchWithCredentials("deepseek", await discoverCredentials("deepseek"), (credential) =>
    fetchWithTimeout("https://api.deepseek.com/user/balance", {
      headers: { Authorization: `Bearer ${credential.secret}`, Accept: "application/json" },
    }),
  );
  const res = result.response;
  if (!res) return credentialDetail(fallback, result.detail);
  if (!res.ok) {
    console.log(`[usage-remaining] deepseek: ${res.status} from balance endpoint via ${result.credential?.sourceLabel}`);
    return credentialDetail(fallback, `${result.detail} · Query failed (${res.status})`);
  }
  const parsed = parseDeepSeekBalance(await res.json());
  return credentialDetail(parsed.length > 0 ? parsed : fallback, result.detail);
}

// Claude Code rotates its OAuth token while agents run; the old token 401s for a
// moment and the rows would flicker out. Serve the last good value instead.
const lastGood = new Map<string, { row: RemainingRow; at: number }>();
const LAST_GOOD_TTL_MS = 6 * 60 * 60_000;
const CLAUDE_META_KEY = "_claude";
const CACHE_PATH = join(process.env.PASEO_HOME || join(home, ".paseo"), "usage-remaining.cache.json");
let cacheLoaded = false;
let savePending = false;

async function loadCache(): Promise<void> {
  if (cacheLoaded) return;
  cacheLoaded = true;
  const raw = await readJson(CACHE_PATH);
  if (raw && typeof raw === "object") {
    for (const [id, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (id === CLAUDE_META_KEY) {
        const meta = entry as { tokenCooldowns?: Record<string, number>; lastAt?: number } | null;
        for (const [key, until] of Object.entries(meta?.tokenCooldowns ?? {})) {
          if (typeof until === "number" && until > Date.now()) claudeTokenCooldownUntil.set(key, until);
        }
        if (typeof meta?.lastAt === "number") lastClaudeAt = Math.max(lastClaudeAt, meta.lastAt);
        continue;
      }
      const cached = entry as { row?: RemainingRow; at?: number } | null;
      if (cached && typeof cached.at === "number" && cached.row) lastGood.set(id, { row: cached.row, at: cached.at });
    }
  }
}

function saveCache(): void {
  if (savePending) return;
  savePending = true;
  setTimeout(() => {
    savePending = false;
    const obj: Record<string, unknown> = Object.fromEntries(lastGood.entries());
    obj[CLAUDE_META_KEY] = { tokenCooldowns: Object.fromEntries(claudeTokenCooldownUntil.entries()), lastAt: lastClaudeAt };
    void writeFile(CACHE_PATH, JSON.stringify(obj)).catch(() => undefined);
  }, 500);
}

// A cached row whose window already reset is worse than no data: it would show
// the pre-reset remaining % next to "now" until the provider API answers again.
function cachedWindowHasReset(cached: RemainingRow, now: number): boolean {
  if (!cached.resetIso) return false;
  const resetMs = new Date(cached.resetIso).getTime();
  return Number.isFinite(resetMs) && resetMs <= now;
}

// A provider that answered recently but is not answering now stays visible as a
// dimmed "—" chip (status "error") instead of silently dropping out of the strip.
// Rows that never had data (not signed in) stay "unavailable" and hidden.
export function withLastGood(
  rows: RemainingRow[],
  now: number = Date.now(),
  cache: Map<string, { row: RemainingRow; at: number }> = lastGood,
): RemainingRow[] {
  let updated = false;
  const merged = rows.map((r) => {
    if (r.status === "available") {
      cache.set(r.id, { row: r, at: now });
      updated = true;
      return r;
    }
    const cached = cache.get(r.id);
    if (cached && now - cached.at <= LAST_GOOD_TTL_MS) {
      if (cachedWindowHasReset(cached.row, now)) {
        return {
          ...r,
          remainingText: "—",
          remainingPct: null,
          resetAt: null,
          resetIso: null,
          tone: "default" as const,
          status: "error" as const,
          detail: "Window reset; waiting for provider",
        };
      }
      // Never serve a frozen countdown: recompute it, or drop it when the cached
      // row predates absolute reset timestamps.
      return {
        ...cached.row,
        resetAt: cached.row.resetIso ? resetLabel(cached.row.resetIso, now) : null,
        detail: r.detail
          ? `${cached.row.detail ? `${cached.row.detail} · ` : ""}Latest refresh: ${r.detail}`
          : cached.row.detail,
      };
    }
    return r;
  });
  if (updated && cache === lastGood) saveCache();
  return merged;
}

function pillText(rows: RemainingRow[]): string {
  return rows.map((r) => `${r.label} ${r.remainingText}`).join(" · ");
}

export async function fetchUsage(input: { force?: boolean } = {}): Promise<UsageSnapshot> {
  await loadCache();
  const [claude, codex, grok, cursor, kimi, glm, deepseek] = await Promise.allSettled([
    fetchClaude(),
    fetchCodex(),
    fetchGrok(),
    fetchCursor(),
    fetchKimi(),
    fetchGlm(),
    fetchDeepSeek(),
  ]);
  for (const [name, result] of [["claude", claude], ["codex", codex], ["grok", grok], ["cursor", cursor], ["kimi", kimi], ["glm", glm], ["deepseek", deepseek]] as const) {
    if (result.status === "rejected") {
      const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
      console.log(`[usage-remaining] ${name}: fetch failed (${reason})`);
    }
  }
  const rows: RemainingRow[] = [];
  rows.push(...(claude.status === "fulfilled" ? claude.value : [
    baseRow("claude_session", "claude", "session", "Claude"),
    baseRow("claude_week", "claude", "weekly", "Claude"),
    baseRow("fable_week", "fable", "weekly", "Fable"),
  ]));
  rows.push(...(codex.status === "fulfilled" ? codex.value : [
    baseRow("codex_session", "codex", "session", "Codex"),
    baseRow("codex_week", "codex", "weekly", "Codex"),
  ]));
  rows.push(grok.status === "fulfilled" ? grok.value : baseRow("grok_week", "grok", "weekly", "Grok"));
  rows.push(cursor.status === "fulfilled" ? cursor.value : baseRow("cursor_month", "cursor", "weekly", "Cursor"));
  rows.push(...(kimi.status === "fulfilled" ? kimi.value : [
    baseRow("kimi_session", "kimi", "session", "Kimi"),
    baseRow("kimi_week", "kimi", "weekly", "Kimi"),
  ]));
  rows.push(...(glm.status === "fulfilled" ? glm.value : [
    baseRow("glm_session", "glm", "session", "GLM"),
    baseRow("glm_mcp", "glm", "weekly", "GLM MCP"),
  ]));
  rows.push(...(deepseek.status === "fulfilled" ? deepseek.value : [
    baseRow("deepseek_balance", "deepseek", "balance", "DeepSeek"),
  ]));

  const merged = withLastGood(rows);
  const session = merged.filter((r) => r.group === "session");
  const weekly = merged.filter((r) => r.group === "weekly");
  const balance = merged.filter((r) => r.group === "balance");
  return {
    fetchedAt: new Date().toISOString(),
    pillText: pillText(merged.filter((item) => item.status !== "unavailable")),
    rows: [...session, ...weekly, ...balance],
  };
}
