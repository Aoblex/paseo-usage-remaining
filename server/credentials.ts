import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, rmdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export type CredentialProvider = "codex" | "grok" | "kimi" | "glm" | "deepseek";
export type CredentialSource = "env" | "pi" | "opencode" | "official-cli";
export type CredentialKind = "oauth" | "api-key";

export type CredentialCandidate = {
  provider: CredentialProvider;
  source: CredentialSource;
  sourceLabel: string;
  kind: CredentialKind;
  secret: string;
  accountId?: string;
  providerId?: string;
  expiresAt?: number;
  refresh?: (force?: boolean) => Promise<CredentialCandidate | null>;
};

export type CredentialFetchResult = {
  response: Response | null;
  credential: CredentialCandidate | null;
  detail: string;
};

const home = homedir();
const PI_AUTH_PATH = join(home, ".pi", "agent", "auth.json");
const FETCH_TIMEOUT_MS = 15_000;

async function fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
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
const DEFAULT_PRIORITY: CredentialSource[] = ["env", "pi", "opencode", "official-cli"];
const SOURCE_LABELS: Record<CredentialSource, string> = {
  env: "environment",
  pi: "Pi",
  opencode: "OpenCode",
  "official-cli": "official CLI",
};

export async function readJson(path: string): Promise<unknown | null> {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function configuredPriority(): CredentialSource[] {
  const configured = process.env.USAGE_REMAINING_CREDENTIAL_PRIORITY?.split(",")
    .map((value) => value.trim())
    .filter((value): value is CredentialSource => DEFAULT_PRIORITY.includes(value as CredentialSource));
  return [...new Set([...(configured ?? []), ...DEFAULT_PRIORITY])];
}

export function sortCredentialCandidates(
  candidates: CredentialCandidate[],
  priority: CredentialSource[] = configuredPriority(),
): CredentialCandidate[] {
  const rank = new Map(priority.map((source, index) => [source, index]));
  const seen = new Set<string>();
  return [...candidates]
    .sort((a, b) => (rank.get(a.source) ?? priority.length) - (rank.get(b.source) ?? priority.length))
    .filter((candidate) => {
      const identity = [
        candidate.secret,
        candidate.accountId ?? "",
        candidate.providerId ?? "",
        candidate.expiresAt ?? "",
        candidate.refresh ? "refreshable" : "",
      ].join("\0");
      const key = createHash("sha256").update(identity).digest("hex");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function candidate(
  provider: CredentialProvider,
  source: CredentialSource,
  kind: CredentialKind,
  secret: unknown,
  extra: Pick<CredentialCandidate, "accountId" | "providerId" | "expiresAt" | "refresh"> = {},
): CredentialCandidate | null {
  if (typeof secret !== "string" || !secret.trim()) return null;
  return {
    provider,
    source,
    sourceLabel: SOURCE_LABELS[source],
    kind,
    secret: secret.trim(),
    ...extra,
  };
}

function authEntryCandidates(
  auth: unknown,
  provider: CredentialProvider,
  source: "pi" | "opencode",
  providerIds: string[],
): CredentialCandidate[] {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return [];
  const result: CredentialCandidate[] = [];
  for (const providerId of providerIds) {
    const entry = (auth as Record<string, unknown>)[providerId];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const kind: CredentialKind = record.type === "oauth" ? "oauth" : "api-key";
    const found = candidate(provider, source, kind, kind === "oauth" ? record.access : record.key ?? record.access, {
      accountId: typeof record.accountId === "string" ? record.accountId : undefined,
      providerId,
      expiresAt: typeof record.expires === "number" ? record.expires : undefined,
    });
    if (found) result.push(found);
  }
  return result;
}

async function readOpenCodeAuth(): Promise<unknown | null> {
  if (process.env.OPENCODE_AUTH_CONTENT) {
    try {
      return JSON.parse(process.env.OPENCODE_AUTH_CONTENT);
    } catch {
      return null;
    }
  }
  const dataHome = process.env.XDG_DATA_HOME || join(home, ".local", "share");
  return readJson(join(dataHome, "opencode", "auth.json"));
}

async function withPiAuthLock<T>(fn: (auth: Record<string, unknown>) => Promise<T>): Promise<T | null> {
  const lockPath = `${PI_AUTH_PATH}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(lockPath);
      locked = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") return null;
      // Our refresh request is capped at 15s. A lock older than 30s cannot be
      // live, so atomically move it aside before retrying. The rename prevents
      // two waiters from both deleting a newly acquired lock.
      try {
        const lockStat = await stat(lockPath);
        if (Date.now() - lockStat.mtimeMs > 30_000) {
          const stalePath = `${lockPath}.stale.${process.pid}.${Date.now()}`;
          await rename(lockPath, stalePath);
          await rmdir(stalePath).catch(() => undefined);
          continue;
        }
      } catch {
        // The owner may have released it between stat and rename.
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  if (!locked) return null;
  try {
    const auth = await readJson(PI_AUTH_PATH);
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
    return await fn(auth as Record<string, unknown>);
  } finally {
    await rmdir(lockPath).catch(() => undefined);
  }
}

// Kimi access tokens last around 15 minutes. Pi owns this credential, so its
// source adapter uses Pi's lock directory and updates only the provider entry.
async function refreshPiKimi(expectedAccess: string, force = false): Promise<CredentialCandidate | null> {
  return withPiAuthLock(async (auth) => {
    const current = auth["kimi-coding"] as {
      type?: string;
      access?: string;
      refresh?: string;
      expires?: number;
    } | undefined;
    if (current?.type !== "oauth" || !current.access || !current.refresh) return null;
    const wrap = (access: string, expiresAt?: number) => candidate("kimi", "pi", "oauth", access, {
      providerId: "kimi-coding",
      expiresAt,
      refresh: (nextForce) => refreshPiKimi(access, nextForce),
    });
    // Another Pi process may have rotated the token while this request was in
    // flight. Try that newer generation instead of refreshing it again.
    if (current.access !== expectedAccess) return wrap(current.access, current.expires);
    if (!force && typeof current.expires === "number" && current.expires > Date.now() + 60_000) {
      return wrap(current.access, current.expires);
    }

    const response = await fetchWithTimeout("https://auth.kimi.com/api/oauth/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        client_id: "17e5f671-d194-4dfb-9706-5516cb48c098",
        grant_type: "refresh_token",
        refresh_token: current.refresh,
      }).toString(),
    });
    const body = await response.json().catch(() => null) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    } | null;
    if (!response.ok || !body?.access_token || typeof body.expires_in !== "number") return null;

    const updated = {
      ...current,
      access: body.access_token,
      refresh: body.refresh_token || current.refresh,
      expires: Date.now() + body.expires_in * 1000,
    };
    auth["kimi-coding"] = updated;
    const temporaryPath = `${PI_AUTH_PATH}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(auth, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    await rename(temporaryPath, PI_AUTH_PATH);
    return wrap(updated.access, updated.expires);
  });
}

function extractGrokSecret(auth: unknown): string | null {
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
  const record = auth as Record<string, unknown>;
  if (typeof record.access_token === "string" && record.access_token) return record.access_token;
  const entries = Object.entries(record);
  const preferred = entries.filter(([key]) => key.startsWith("https://auth.x.ai::"));
  for (const [, value] of preferred.length > 0 ? preferred : entries) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const key = (value as Record<string, unknown>).key;
    if (typeof key === "string" && key) return key;
  }
  return null;
}

const SOURCE_IDS: Record<CredentialProvider, string[]> = {
  codex: ["openai-codex", "openai"],
  grok: ["xai", "grok"],
  kimi: ["kimi-coding", "kimi-for-coding", "kimi-for-coding-oauth", "kimi-code", "moonshotai-cn", "moonshotai", "kimi"],
  glm: ["glm", "zai-coding-cn", "zai-coding-plan-cn", "zai-coding-plan", "zai", "zhipu"],
  deepseek: ["deepseek"],
};

function envCandidates(provider: CredentialProvider): CredentialCandidate[] {
  const values: Partial<Record<CredentialProvider, Array<string | undefined>>> = {
    codex: [process.env.CODEX_ACCESS_TOKEN],
    grok: [process.env.GROK_API_KEY, process.env.GROK_TOKEN],
    kimi: [process.env.KIMI_CODE_ACCESS_TOKEN],
    glm: [
      process.env.Z_AI_API_KEY,
      process.env.ANTHROPIC_BASE_URL?.includes("bigmodel") ? process.env.ANTHROPIC_AUTH_TOKEN : undefined,
    ],
    deepseek: [process.env.DEEPSEEK_API_KEY],
  };
  return (values[provider] ?? []).flatMap((secret) => {
    const providerId = provider === "glm" && process.env.ANTHROPIC_BASE_URL?.includes("bigmodel")
      ? "zai-coding-cn"
      : undefined;
    const found = candidate(
      provider,
      "env",
      provider === "codex" || provider === "kimi" ? "oauth" : "api-key",
      secret,
      { providerId },
    );
    return found ? [found] : [];
  });
}

async function officialCandidates(provider: CredentialProvider): Promise<CredentialCandidate[]> {
  if (provider === "codex") {
    const paths = [
      process.env.CODEX_HOME ? join(process.env.CODEX_HOME, "auth.json") : "",
      join(home, ".codex", "auth.json"),
      join(home, ".config", "codex", "auth.json"),
    ].filter(Boolean);
    for (const path of paths) {
      const tokens = (await readJson(path) as { tokens?: { access_token?: string; account_id?: string } } | null)?.tokens;
      const found = candidate(provider, "official-cli", "oauth", tokens?.access_token, { accountId: tokens?.account_id });
      if (found) return [found];
    }
  }
  if (provider === "grok") {
    const found = candidate(provider, "official-cli", "oauth", extractGrokSecret(await readJson(join(home, ".grok", "auth.json"))));
    return found ? [found] : [];
  }
  if (provider === "kimi") {
    const auth = await readJson(join(home, ".kimi-code", "credentials", "kimi-code.json"));
    const found = candidate(provider, "official-cli", "oauth", (auth as { access_token?: string } | null)?.access_token);
    return found ? [found] : [];
  }
  if (provider === "glm") {
    const configHome = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const auth = await readJson(join(configHome, "glm-acp-agent", "credentials.json"));
    const found = candidate(provider, "official-cli", "api-key", (auth as { z_ai_api_key?: string } | null)?.z_ai_api_key, {
      providerId: process.env.ANTHROPIC_BASE_URL?.includes("bigmodel") ? "zai-coding-cn" : "zai",
    });
    return found ? [found] : [];
  }
  const auth = await readJson(join(home, ".deepseek", "auth.json"));
  const found = candidate(provider, "official-cli", "api-key", (auth as { api_key?: string } | null)?.api_key);
  return found ? [found] : [];
}

export async function discoverCredentials(provider: CredentialProvider): Promise<CredentialCandidate[]> {
  const [piAuth, openCodeAuth, official] = await Promise.all([
    readJson(PI_AUTH_PATH),
    readOpenCodeAuth(),
    officialCandidates(provider),
  ]);
  const piKimiAccess = provider === "kimi"
    ? ((piAuth as Record<string, unknown> | null)?.["kimi-coding"] as { access?: unknown } | undefined)?.access
    : undefined;
  const pi = authEntryCandidates(piAuth, provider, "pi", SOURCE_IDS[provider]).map((found) =>
    provider === "kimi" && found.kind === "oauth" && found.secret === piKimiAccess
      ? { ...found, refresh: (force?: boolean) => refreshPiKimi(found.secret, force) }
      : found,
  );
  const openCode = authEntryCandidates(openCodeAuth, provider, "opencode", SOURCE_IDS[provider]);
  return sortCredentialCandidates([...envCandidates(provider), ...pi, ...openCode, ...official]);
}

async function beforeDeadline<T>(operation: () => Promise<T>, deadline: number): Promise<T> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("credential deadline exceeded");
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("credential deadline exceeded")), remaining);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function isAuthenticationRejection(provider: CredentialProvider, response: Response): Promise<boolean> {
  if (response.status === 401 || response.status === 403) return true;
  if (provider !== "codex") return false;
  if (response.headers.get("content-type")?.toLowerCase().includes("text/html")) return true;
  const text = await response.clone().text();
  return text.trimStart().startsWith("<");
}

export async function fetchWithCredentials(
  provider: CredentialProvider,
  credentials: CredentialCandidate[],
  request: (credential: CredentialCandidate) => Promise<Response>,
  now: number = Date.now(),
): Promise<CredentialFetchResult> {
  if (credentials.length === 0) return { response: null, credential: null, detail: "No supported credentials found" };
  const deadline = Date.now() + FETCH_TIMEOUT_MS;
  const rejected: string[] = [];
  const expired: string[] = [];
  const failed: string[] = [];

  for (const original of credentials) {
    if (Date.now() >= deadline) break;
    let active = original;
    if (active.expiresAt != null && active.expiresAt <= now + 30_000) {
      try {
        const refreshed = active.refresh
          ? await beforeDeadline(() => active.refresh!(false), deadline)
          : null;
        if (!refreshed) {
          expired.push(active.sourceLabel);
          continue;
        }
        active = refreshed;
      } catch {
        failed.push(active.sourceLabel);
        continue;
      }
    }

    let response: Response;
    try {
      response = await beforeDeadline(() => request(active), deadline);
    } catch {
      failed.push(active.sourceLabel);
      continue;
    }
    let rejectedResponse = await isAuthenticationRejection(provider, response);
    if (rejectedResponse && active.refresh) {
      try {
        const refreshed = await beforeDeadline(() => active.refresh!(true), deadline);
        if (refreshed) {
          active = refreshed;
          response = await beforeDeadline(() => request(active), deadline);
          rejectedResponse = await isAuthenticationRejection(provider, response);
        }
      } catch {
        failed.push(active.sourceLabel);
        continue;
      }
    }
    if (rejectedResponse) {
      rejected.push(active.sourceLabel);
      continue;
    }
    return { response, credential: active, detail: `credential: ${active.sourceLabel}` };
  }

  const reasons = [
    rejected.length ? `Rejected: ${[...new Set(rejected)].join(", ")}` : "",
    expired.length ? `Expired: ${[...new Set(expired)].join(", ")}` : "",
    failed.length ? `Failed: ${[...new Set(failed)].join(", ")}` : "",
  ].filter(Boolean);
  return { response: null, credential: null, detail: reasons.join(" · ") || "No usable credentials" };
}
