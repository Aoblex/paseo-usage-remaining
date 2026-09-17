import type { RemainingRow } from "../shared/usage";

export type ProviderUsage = {
  id: string;
  brand: RemainingRow["brand"];
  label: string;
  status: RemainingRow["status"];
  credentialSource: string | null;
  metrics: RemainingRow[];
  details: string[];
};

const PROVIDER_ORDER = ["claude", "codex", "grok", "cursor", "kimi", "glm", "deepseek"];
const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  grok: "Grok",
  cursor: "Cursor",
  kimi: "Kimi",
  glm: "GLM",
  deepseek: "DeepSeek",
};

const METRIC_LABELS: Record<string, string> = {
  claude_session: "Session",
  claude_week: "Weekly",
  fable_week: "Fable weekly",
  codex_session: "Session",
  codex_week: "Weekly",
  grok_week: "Plan usage",
  cursor_month: "Monthly",
  kimi_session: "Session",
  kimi_week: "Weekly",
  kimi_balance: "Extra usage",
  glm_session: "Token / credit",
  glm_week: "Weekly",
  glm_mcp: "MCP",
  deepseek_balance: "API balance",
};

function providerId(row: RemainingRow): string {
  // Extra Codex account slots share the Codex brand but keep their own card.
  if (row.providerKey) return row.providerKey;
  return row.brand === "fable" ? "claude" : row.brand;
}

export function metricLabel(row: RemainingRow): string {
  if (row.metricLabel) return row.metricLabel;
  if (METRIC_LABELS[row.id]) return METRIC_LABELS[row.id];
  if (row.id.startsWith("deepseek_balance_")) return "API balance";
  if (row.group === "session") return "Session";
  if (row.group === "balance") return "Balance";
  return "Weekly";
}

function readableDetail(detail: string): string {
  if (detail === "not signed in or no usage data") return "Not signed in or no usage data";
  if (detail === "no supported credentials found") return "No supported credentials found";
  if (detail === "no 5-hour window on this plan") return "Session limit is not available on this plan";
  if (detail === "window reset · waiting for provider") return "Window reset; waiting for provider";
  return detail;
}

function detailParts(detail: string | null): { source: string | null; messages: string[] } {
  if (!detail) return { source: null, messages: [] };
  let source: string | null = null;
  const messages: string[] = [];
  for (const rawPart of detail.split("·")) {
    let part = rawPart.trim();
    const sourceMatch = part.match(/(?:^|latest refresh:\s*)credential:\s*(.+)$/i);
    if (sourceMatch) {
      source ??= sourceMatch[1].trim();
      if (/^latest refresh:/i.test(part)) continue;
      continue;
    }
    part = part.replace(/credential:\s*[^·]+/i, "").trim();
    if (!part) continue;
    if (part === "extra usage balance" || part === "API account balance" || part === "monthly") continue;
    const readable = readableDetail(part);
    if (readable === "Session limit is not available on this plan") continue;
    messages.push(readable);
  }
  return { source, messages };
}

export function groupRowsByProvider(rows: RemainingRow[]): ProviderUsage[] {
  const grouped = new Map<string, RemainingRow[]>();
  for (const row of rows) {
    const id = providerId(row);
    const current = grouped.get(id) ?? [];
    current.push(row);
    grouped.set(id, current);
  }

  return [...grouped.entries()]
    .map(([id, providerRows]): ProviderUsage => {
      let credentialSource: string | null = null;
      const detailSet = new Set<string>();
      for (const row of providerRows) {
        const parsed = detailParts(row.detail);
        credentialSource ??= parsed.source;
        for (const message of parsed.messages) detailSet.add(message);
      }
      const hasAvailable = providerRows.some((row) => row.status === "available");
      const specificDetails = [...detailSet].filter((detail) => !(detail === "Not signed in or no usage data" && (hasAvailable || detailSet.size > 1)));
      const hasFailureDetail = specificDetails.some((detail) => /query failed|rejected:|expired:|failed:|window reset/i.test(detail));
      const hasError = providerRows.some((row) => row.status === "error") || hasFailureDetail;
      return {
        id,
        // The brand drives the logo and colour, so it comes from the rows rather
        // than the group id ("codex-2" is still Codex).
        brand: providerRows[0]?.brand ?? "codex",
        label: PROVIDER_LABELS[id] ?? providerRows[0]?.label ?? id,
        status: hasError ? "error" : hasAvailable ? "available" : "unavailable",
        credentialSource,
        metrics: providerRows.filter((row) => row.status !== "unavailable"),
        details: specificDetails,
      };
    })
    .sort((a, b) => {
      const aIndex = PROVIDER_ORDER.indexOf(a.brand);
      const bIndex = PROVIDER_ORDER.indexOf(b.brand);
      // Account slots share a brand, so order them by slot instead of by whichever
      // window the provider happened to report first.
      return (aIndex < 0 ? PROVIDER_ORDER.length : aIndex) - (bIndex < 0 ? PROVIDER_ORDER.length : bIndex)
        || a.id.localeCompare(b.id);
    });
}
