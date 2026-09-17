import type { ComponentType } from "react";
import type { PluginClientContext, PluginButtonRegistration, PluginButtonIcon, PluginButtonContentProps } from "@getpaseo/plugin/client";
import type { UsageSnapshot } from "../shared/usage";
import { groupRowsByProvider, visibleMetrics } from "./provider-groups.ts";

type Agent = { id: string; workspaceId?: string | null; provider: string; model?: string | null };

const KNOWN_BRANDS = new Set(["claude", "fable", "codex", "grok", "cursor", "kimi", "glm", "deepseek"]);

// Pi and OpenCode serve every configured model under one provider id, so their
// models name the upstream provider instead: `openai-codex/gpt-5.6-sol`.
const MODEL_BRANDS: Record<string, string> = {
  anthropic: "claude",
  "openai-codex": "codex",
  openai: "codex",
  "kimi-coding": "kimi",
  "kimi-for-coding": "kimi",
  moonshotai: "kimi",
  "moonshotai-cn": "kimi",
  "zai-coding-plan": "glm",
  "zai-coding-cn": "glm",
  zai: "glm",
  zhipu: "glm",
  xai: "grok",
};

// Null means "cannot tell", which falls back to summarizing every provider rather
// than claiming the agent has no usage. That is what made every Pi agent's pill
// read "Usage unavailable": Paseo keeps the model out of `provider`.
function agentBrand(provider: string, model: string | null | undefined): string | null {
  const fromProvider = provider.split("/")[0];
  if (KNOWN_BRANDS.has(fromProvider)) return fromProvider;
  const fromModel = model?.split("/")[0] ?? "";
  if (!fromModel) return null;
  const resolved = MODEL_BRANDS[fromModel] ?? fromModel;
  return KNOWN_BRANDS.has(resolved) ? resolved : null;
}

export function usageLabel(provider: string, model: string | null | undefined, snapshot?: UsageSnapshot): string {
  if (!snapshot) return "Usage…";
  const brand = agentBrand(provider, model);
  // Same grouping as the strip, so this label can never disagree with what the
  // composer shows. Repeating one label would otherwise make a bare "92%" ambiguous.
  const cards = groupRowsByProvider(snapshot.rows)
    .filter((card) => (brand === null || card.brand === brand) && card.metrics.length > 0)
    .map((card) => ({
      label: card.label,
      values: visibleMetrics(card).map((row) => `${row.remainingText}${row.resetAt ? ` ${row.resetAt}` : ""}`).join(" · "),
    }));
  if (!cards.length) return "Usage unavailable";
  if (cards.length === 1) return `${cards[0].label} · ${cards[0].values}`;
  return cards.map((card) => `${card.label} ${card.values}`).join(" · ");
}

// Use the SDK shipped with Paseo 0.8.0, not the newer unreleased owned-list API.
export function registerUsagePills(client: PluginClientContext, fetchUsage: () => Promise<UsageSnapshot>, icon: PluginButtonIcon = "Gauge", mobileContent?: ComponentType<PluginButtonContentProps>) {
  const pills = new Map<string, { agent: Agent; registration: PluginButtonRegistration }>();
  const changedDuringBootstrap = new Set<string>();
  let stopped = false;
  let bootstrapping = true;
  let fetching = false;
  let snapshot: UsageSnapshot | undefined;

  function remove(id: string) {
    pills.get(id)?.registration.remove();
    pills.delete(id);
  }

  function upsert(agent: Agent) {
    if (stopped) return;
    if (!agent.workspaceId) { remove(agent.id); return; }
    const existing = pills.get(agent.id);
    const label = usageLabel(agent.provider, agent.model, snapshot);
    if (existing?.agent.workspaceId === agent.workspaceId) {
      existing.agent = agent;
      existing.registration.update({ label });
      return;
    }
    remove(agent.id);
    const registration = client.addComposerPill({
      id: "usage", workspaceId: agent.workspaceId, agentId: agent.id,
      button: {
        title: "Remaining usage · open all providers", icon, label,
        behavior: mobileContent ? { kind: "popover", Content: mobileContent } : { kind: "action", onPress() { client.openSurface("main"); } },
      },
    });
    pills.set(agent.id, { agent, registration });
  }

  const unsubscribe = client.paseo.agents.subscribe((update) => {
    if (stopped) return;
    const id = update.kind === "remove" ? update.agentId : update.agent.id;
    if (bootstrapping) changedDuringBootstrap.add(id);
    if (update.kind === "remove") remove(id);
    else upsert(update.agent);
  });

  void (async () => {
    let cursor: string | undefined;
    do {
      const result = await client.paseo.agents.list({ page: { limit: 100, cursor } });
      if (stopped) return;
      for (const { agent } of result.entries) {
        if (!changedDuringBootstrap.has(agent.id)) upsert(agent);
      }
      const next = result.pageInfo?.nextCursor ?? undefined;
      if (!result.pageInfo?.hasMore || !next || next === cursor) break;
      cursor = next;
    } while (!stopped);
  })().catch(() => {
    if (!stopped) console.error("[usage-remaining] Agent list unavailable; live updates remain subscribed.");
  }).finally(() => { bootstrapping = false; changedDuringBootstrap.clear(); });

  async function refresh() {
    if (stopped || fetching) return;
    fetching = true;
    try {
      const next = await fetchUsage();
      if (stopped) return;
      snapshot = next;
      for (const { agent, registration } of pills.values()) {
        registration.update({ label: usageLabel(agent.provider, agent.model, snapshot) });
      }
    } catch {
      if (!stopped) for (const { registration } of pills.values()) registration.update({ label: "Usage unavailable" });
    } finally { fetching = false; }
  }
  void refresh();
  const timer = setInterval(() => void refresh(), 10_000);
  return () => {
    stopped = true;
    clearInterval(timer);
    unsubscribe();
    for (const { registration } of pills.values()) registration.remove();
    pills.clear();
  };
}
