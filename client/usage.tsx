import { type PluginClientContext, type PluginSurfaceProps, type PluginButtonIconProps, type PluginButtonContentProps, useRpc } from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/react-native";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Image, Platform, ScrollView, StyleSheet, Text, useWindowDimensions, View } from "react-native";
import { expandNativeComposer } from "./native-composer";
import { expandWebComposer } from "./web-composer";
import { registerUsagePills } from "./registry";
import { providerLogos } from "./logos";
import { compactWindowLabel, groupRowsByProvider, metricLabel, type ProviderUsage } from "./provider-groups";
import { listUsage, type RemainingRow } from "../shared/usage";

type Theme = PluginSurfaceProps["theme"];

const QUERY_KEY = ["usage-remaining"] as const;
const AUTO_REFRESH_MS = 10_000;

function toneColor(theme: Theme, tone: RemainingRow["tone"]): string {
  if (tone === "ok") return theme.colors.statusSuccess;
  if (tone === "warning") return theme.colors.statusWarning;
  if (tone === "danger") return theme.colors.statusDanger;
  return theme.colors.foregroundMuted;
}

function useUsage() {
  const list = useRpc(listUsage);
  return useQuery({
    queryKey: QUERY_KEY,
    queryFn: () => list({}),
    refetchInterval: AUTO_REFRESH_MS,
    staleTime: 5_000,
  });
}

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

function formatAgo(iso: string | undefined, now: number): string | null {
  if (!iso) return null;
  const ms = now - new Date(iso).getTime();
  if (!Number.isFinite(ms) || ms < 0) return null;
  const seconds = Math.floor(ms / 1_000);
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

function CompactProviderChip({ provider, theme, narrow }: { provider: ProviderUsage; theme: Theme; narrow: boolean }) {
  const uri = providerLogos[provider.brand];
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        paddingHorizontal: 7,
        paddingVertical: 3,
        borderRadius: 999,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: theme.colors.border,
        backgroundColor: theme.colors.surface2,
      }}
    >
      {uri ? <Image source={{ uri }} style={{ width: 14, height: 14, borderRadius: 3 }} /> : null}
      {narrow ? null : <Text style={{ color: theme.colors.foreground, fontSize: 11, fontWeight: "600" }}>{provider.label}</Text>}
      {provider.metrics.map((row, index) => {
        const period = compactWindowLabel(row);
        const reset = row.resetAt && row.resetAt !== period ? row.resetAt : null;
        return (
          <View key={row.id} style={{ flexDirection: "row", alignItems: "baseline", gap: 3 }}>
            {index > 0 ? <Text style={{ color: theme.colors.border, fontSize: 11, marginHorizontal: 1 }}>|</Text> : null}
            {period ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "600" }}>{period}</Text> : null}
            <Text
              style={{
                color: row.status === "available" ? toneColor(theme, row.tone) : theme.colors.foregroundMuted,
                fontSize: 12,
                fontWeight: "700",
              }}
            >
              {row.remainingText}
            </Text>
            {reset ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 10 }}>· {reset}</Text> : null}
          </View>
        );
      })}
    </View>
  );
}

function RemainingBar({ row, theme }: { row: RemainingRow; theme: Theme }) {
  if (row.remainingPct == null) return null;
  return (
    <View
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: row.remainingPct }}
      style={{ height: 4, borderRadius: 2, backgroundColor: theme.colors.surface2, overflow: "hidden", marginTop: 10 }}
    >
      <View style={{ width: `${row.remainingPct}%`, height: "100%", backgroundColor: toneColor(theme, row.tone) }} />
    </View>
  );
}

function ProviderMark({ provider, theme }: { provider: ProviderUsage; theme: Theme }) {
  const uri = providerLogos[provider.brand];
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 8, minWidth: 0 }}>
      {uri ? <Image source={{ uri }} style={{ width: 26, height: 26, borderRadius: 6 }} /> : null}
      <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 17, fontWeight: "700", flexShrink: 1 }}>
        {provider.label}
      </Text>
    </View>
  );
}

function ProviderMetric({ row, theme, last }: { row: RemainingRow; theme: Theme; last: boolean }) {
  return (
    <View
      style={{
        paddingVertical: 10,
        borderBottomWidth: last ? 0 : StyleSheet.hairlineWidth,
        borderBottomColor: theme.colors.border,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "baseline", justifyContent: "space-between", gap: 12 }}>
        <Text style={{ color: theme.colors.foreground, fontSize: 13, fontWeight: "600", flexShrink: 1 }}>
          {metricLabel(row)}
        </Text>
        <View style={{ flexDirection: "row", alignItems: "baseline", gap: 7 }}>
          <Text style={{ color: row.status === "available" ? toneColor(theme, row.tone) : theme.colors.foregroundMuted, fontSize: 17, fontWeight: "700" }}>
            {row.remainingText}
          </Text>
          {row.resetAt ? <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>{row.resetAt}</Text> : null}
        </View>
      </View>
      <RemainingBar row={row} theme={theme} />
    </View>
  );
}

function ProviderCard({ provider, theme, compact }: { provider: ProviderUsage; theme: Theme; compact: boolean }) {
  const unavailable = provider.status !== "available";
  const badge = provider.credentialSource
    ? `${provider.credentialSource}${provider.status === "error" ? " · issue" : ""}`
    : provider.status === "unavailable" ? "Not configured" : provider.status === "error" ? "Unavailable" : "Available";
  const details = provider.details.length > 0
    ? provider.details
    : provider.status === "unavailable" ? ["No credentials or usage data found"] : [];
  return (
    <View
      style={{
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.border,
        borderWidth: 1,
        borderRadius: 14,
        paddingHorizontal: compact ? 12 : 16,
        paddingVertical: compact ? 12 : 14,
        opacity: unavailable ? 0.68 : 1,
        width: "100%",
        minWidth: 0,
      }}
    >
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12, paddingBottom: provider.metrics.length ? 4 : 8 }}>
        <ProviderMark provider={provider} theme={theme} />
        <View style={{ backgroundColor: theme.colors.surface2, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 4 }}>
          <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted, fontSize: 10, fontWeight: "700" }}>{badge}</Text>
        </View>
      </View>
      {provider.metrics.map((row, index) => (
        <ProviderMetric key={row.id} row={row} theme={theme} last={index === provider.metrics.length - 1} />
      ))}
      {details.map((detail) => (
        <Text key={detail} style={{ color: theme.colors.foregroundMuted, fontSize: 12, marginTop: 6 }}>{detail}</Text>
      ))}
    </View>
  );
}

function UsageContent({ theme, layout }: Pick<PluginSurfaceProps, "theme" | "layout">) {
  const usage = useUsage();
  const now = useNow(15_000);
  const providers = useMemo(() => groupRowsByProvider(usage.data?.rows ?? []), [usage.data?.rows]);
  const updated = formatAgo(usage.data?.fetchedAt, now);
  const styles = useMemo(
    () => ({
      screen: {
        flexGrow: 1,
        padding: layout.compact ? 16 : 24,
        backgroundColor: theme.colors.surface0,
        gap: layout.compact ? 10 : 12,
      },
      title: { color: theme.colors.foreground, fontSize: layout.compact ? 20 : 24, fontWeight: "700" as const },
      subtitle: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger },
    }),
    [theme, layout.compact],
  );

  return (
    <View style={styles.screen}>
      <View style={{ gap: 2, flexShrink: 1 }}>
        <Text style={styles.title}>Remaining usage</Text>
        {updated ? <Text style={styles.subtitle}>Updated {updated} · auto-refreshes every 10 seconds</Text> : null}
      </View>
      {usage.isError ? <Text style={styles.error}>{String(usage.error)}</Text> : null}
      {!usage.data && !usage.isError ? <Text style={styles.subtitle}>Loading…</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", alignItems: "stretch", gap: layout.compact ? 10 : 12 }}>
        {providers.map((provider) => (
          <ProviderCard key={provider.id} provider={provider} theme={theme} compact={layout.compact} />
        ))}
      </View>
    </View>
  );
}

export function MainSurface(props: PluginSurfaceProps) {
  return <ScrollView style={{ flex: 1, backgroundColor: props.theme.colors.surface0 }}><UsageContent {...props} /></ScrollView>;
}

// Bound native sheet content explicitly: the host can measure it at full height
// before applying its own scroll limit, pushing the title under the iPhone notch.
export function MobileUsageSheet(props: PluginButtonContentProps) {
  const { height } = useWindowDimensions();
  return (
    <ScrollView style={{ maxHeight: Math.min(440, height * 0.6) }} nestedScrollEnabled>
      <UsageContent theme={props.theme} layout={{ ...props.layout, compact: true }} />
    </ScrollView>
  );
}

export function UsagePill({ theme, layout }: PluginButtonIconProps) {
  const usage = useUsage();
  // Each provider gets one compact capsule; providers with multiple primary
  // windows keep those values together and the whole sequence wraps on phones.
  const narrow = layout.compact;
  const rows = usage.data?.rows ?? [];
  // "error" rows are providers that answered recently but not now (e.g. right after
  // a window reset). Keep them in the strip as a dimmed "—" so a provider never
  // silently disappears; "unavailable" rows never had data and stay hidden.
  // The value format distinguishes percentages, countdowns, and balances.
  const visible = rows.filter((row) => row.status !== "unavailable");
  const providers = groupRowsByProvider(visible).filter((provider) => provider.metrics.length > 0);
  if (providers.length === 0) {
    return (
      <Text numberOfLines={1} style={{ color: theme.colors.foregroundMuted }}>
        {usage.data ? "Usage unavailable" : "Usage…"}
      </Text>
    );
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: narrow ? 8 : 10,
        rowGap: 3,
        flexWrap: "wrap",
        flexShrink: 1,
        minWidth: 0,
        paddingVertical: 1,
      }}
    >
      {providers.map((provider) => (
        <CompactProviderChip key={provider.id} provider={provider} theme={theme} narrow={narrow} />
      ))}
    </View>
  );
}

export function contributeClient(client: PluginClientContext) {
  return registerUsagePills(client, () => client.rpc(listUsage, {}), RichUsageIcon, Platform.OS === "web" ? undefined : MobileUsageSheet);
}

// 0.8 removed custom composer bodies. On the web renderer, keep the original
// rich usage flow inside our own icon mount and expand only its enclosing
// button. Native uses a guarded host adapter to reserve the same wrapping layout.
function RichUsageIcon(props: PluginButtonIconProps) {
  const ref = useRef<View>(null);
  const { width: windowWidth } = useWindowDimensions();
  const [expanded, setExpanded] = useState(false);
  useLayoutEffect(() => {
    if (props.layout.platform !== "web") {
      const cleanup = expandNativeComposer(ref.current, Math.max(200, windowWidth - 32), props.theme.colors.surface0, StyleSheet.flatten);
      setExpanded(cleanup !== null);
      return cleanup ?? undefined;
    }
    const cleanup = expandWebComposer(ref.current, props.theme.colors.surface0);
    setExpanded(cleanup !== null);
    return cleanup ?? undefined;
  }, [props.layout.platform, props.theme.colors.surface0, windowWidth]);
  return (
    <View ref={ref} style={{ minWidth: 0, flexShrink: 1 }}>
      {expanded ? <UsagePill {...props} /> : (
        <Icon name="Gauge" size={props.size} color={props.color} />
      )}
    </View>
  );
}
