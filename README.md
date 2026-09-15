# usage-remaining

A [Paseo](https://paseo.sh) plugin that shows how much AI usage you have **left** — right above the composer.

The composer displays every available provider in one compact horizontal flow: provider logo, remaining percentage or monetary balance, then reset time when present. Value formats distinguish rolling limits from balances without separate `5H`, `WK`, or `BAL` labels. Narrow clients wrap the same sequence when needed.

Green, yellow, and red percentages show remaining capacity. Click the compact flow for the full dashboard; values retain their reset labels and wrap on narrow screens.

On iOS, the same horizontal flow stays above the input and wraps when needed. Tap it to open all providers in a scrollable sheet.
The dashboard and mobile sheet are provider-first: each provider occupies one full-width card with its logo, credential source, and a curated set of user-facing primary limits. Internal API buckets, ambiguous fields, and duplicate legacy/new quota representations are intentionally hidden rather than exposed verbatim. Window labels preserve provider semantics, such as `5-hour rolling usage`, `1-week limit`, `Membership monthly usage`, `Fable · 1-week limit`, `MCP usage · 1 month`, or `API balance`; unsupported or absent windows are omitted rather than shown as placeholders. Fable stays inside Claude and MCP stays inside GLM. Failed refreshes preserve the last values and explain the error inside the affected provider card.

## What it reads

| Provider | Source | Notes |
| --- | --- | --- |
| Claude (session + weekly + Fable weekly) | Claude Code login (macOS Keychain / `~/.claude/.credentials.json` / `CLAUDE_CODE_OAUTH_TOKEN`) | Fable's model-scoped weekly limit is shown as its own entry |
| Codex | Environment, Pi `openai-codex`, OpenCode `openai`/`openai-codex`, or Codex CLI (`~/.codex/auth.json`) | Shows only the account's primary rate-limit windows; model-specific `additional_rate_limits` are hidden |
| Grok | Environment, Pi/OpenCode `xai`/`grok`, or Grok CLI (`~/.grok/auth.json`) | Supports unified-billing (weekly %) and legacy monthly credits. The billing body is protobuf-JSON: zero-valued fields are omitted, so a live period with no usage fields means 0% used (100% remaining) |
| Cursor | Cursor desktop / `cursor-agent` login | Individual plans only — team-billed seats don't expose plan usage |
| Kimi | Environment, Pi/OpenCode Kimi providers, or Kimi Code (`~/.kimi-code/credentials/kimi-code.json`) | Shows the 5-hour window, membership monthly total, confirmed weekly window when returned, and extra-usage balance; internal monthly Code sub-buckets are hidden |
| GLM | Environment, Pi/OpenCode `glm`/`zai` providers, or `~/.config/glm-acp-agent/credentials.json` | Shows returned 5-hour/weekly token or credit windows; legacy monthly MCP appears only when the account API returns it |
| DeepSeek | Environment, Pi/OpenCode `deepseek`, or `~/.deepseek/auth.json` | Shows API account cash balance, not web membership usage |

Pi credentials come from `~/.pi/agent/auth.json`. OpenCode credentials come from `$OPENCODE_AUTH_CONTENT` or `$XDG_DATA_HOME/opencode/auth.json` (normally `~/.local/share/opencode/auth.json`). The plugin discovers candidates without copying them into its own storage, deduplicates identical secrets, and tries the next source after an authentication rejection. The default priority is `env,pi,opencode,official-cli`; override it with a comma-separated `USAGE_REMAINING_CREDENTIAL_PRIORITY`, for example `pi,opencode,official-cli,env`.

Credentials are read locally and are never logged. They are sent only to each provider's own OAuth, usage, or balance API. Kimi's 15-minute Pi OAuth token is refreshed under Pi's credential-file lock with an atomic replacement; only the `kimi-coding` entry in `~/.pi/agent/auth.json` is updated. Other stores are read-only, and the quota cache never contains credentials.

## Install

Requires Paseo **0.8.0 stable** on the daemon and client. Early 0.8 betas use an older composer API. The last revision for Paseo 0.7 is commit `8e4da65`.

1. In Paseo: **Settings → Plugins → Enable plugins**
2. In a terminal:

```bash
paseo plugin add Sundayable/paseo-usage-remaining
```

That's it. Open any workspace — the usage pill appears above the composer.

Update later with:

```bash
paseo plugin update usage-remaining
```

## Behavior details

- Synchronizes automatically every 10s with no manual refresh control. Claude is still polled at most every 5 min. Anthropic's usage endpoint answers `429` (retry-after about an hour) for tokens it will not serve: expired access tokens and long-lived `claude setup-token` tokens. A fresh token from an interactive Claude Code login answers normally. The plugin skips expired tokens without a request, prefers keychain/file tokens over the env setup token, and remembers a per-token cooldown across reloads.
- If the Claude rows stay hidden, the keychain token has expired and nothing is refreshing it (Paseo-launched agents use the setup token). Run `claude` once without `CLAUDE_CODE_OAUTH_TOKEN` in the environment; Claude Code refreshes the keychain credential and the rows return within 5 min.
- If a provider's token is mid-rotation (common while agents run), the plugin serves the **last good value** from a small local cache (`$PASEO_HOME/usage-remaining.cache.json`) instead of flickering to "—". Absolute reset timestamps are cached, so countdown labels keep updating even while the provider API is rate-limited.
- Provider windows that never had data (not signed in) are omitted from the inline display and explained in the dashboard. If none are available, it says `Usage unavailable`.
- A provider that answered recently but stops answering (for example right after its window resets, before the API reports the new period) stays in the strip as a dimmed `—` chip instead of silently disappearing. The dashboard card says `window reset · waiting for provider`.
- Every provider request has a 15-second deadline so one slow API cannot stall the whole strip, and each failure is logged as `[usage-remaining] <provider>: …` in the Paseo daemon log (`~/.paseo/daemon.log`) so a missing chip can be diagnosed from the log alone.
- The rich display uses the 0.8 web compatibility adapter described below. Native clients use a guarded native adapter to restore the same colored horizontal flow, with a scrollable sheet on tap.
- Source changes require `npm run typecheck` followed by `paseo plugin reload usage-remaining`. The 0.8.0 desktop client updates without a daemon restart.
- A cached row is dropped once its own reset time passes, so a stale pre-reset % is never shown next to `now`.
- On native clients the plugin hides Paseo's own git diff badge (`+123 -45`) from the
  composer track, so the phone shows usage only. Paseo 0.8 has no setting for that
  badge, so the native adapter hides the node and restores it when the plugin is
  disabled or unloaded. Desktop and web keep the badge.

## Paseo 0.8 web compatibility

Paseo 0.8 replaced arbitrary composer components with fixed button descriptors.
Its normal button forces muted text, a 160px maximum width, and a clipped 16px icon.
The plugin registers through the supported `button` API, then mounts the original
React Native usage component in its own web icon slot. The original button's
opaque surface, border, and rounded frame remain behind the colored data.

Paseo's track normally floats absolutely over the transcript. A wrapping usage widget
must not remain in that overlay: `client/web-composer.ts` makes the containing
track a normal, nonshrinking flex row with an opaque background. The transcript
viewport gives up exactly the track's height; wrapping provider chips or adjacent
task/diff badges increases the reserved space instead of covering chat text.

The adapter verifies the expected direct ancestors (including the desktop's
`display: contents` tooltip wrapper) before expanding anything. It changes only
this agent's containing track and its own button, and restores all changed styles
and accessibility attributes on unmount. If safe space cannot be reserved, it
leaves the standard button intact. Native clients use `client/native-composer.ts` to expand the owned native icon slot
and reserve track height through `setNativeProps`. The host icon slot centers its
single child, so the adapter also sets `alignItems: 'flex-start'` and the two rows
start at the button's own text edge instead of sitting in a wide centered gutter. It validates the observed Fabric
host structure before touching any styles and restores changed properties on
teardown. This relies on internal React Native host handles; unknown structures
retain the standard button and sheet. Actual iPhone verification covered the
restored always-visible display, app re-entry, opening/closing the sheet, and
scrolling through Cursor. Android remains unverified.
Future host changes require rechecking the adapter against the installed app.

## Caveats

- Paseo's plugin API is experimental; a Paseo update may require a plugin update. This revision uses the stable 0.8 button registration API (`button`, `update`, `remove`) and runtime-entry layout (`index.client.tsx` / `index.server.ts`, `client/` `server/` `shared/`) and declares `requirements.paseo >=0.8.0`.
- Provider usage endpoints are unofficial and can change without notice.
- Cursor team-billed seats return no plan usage from the endpoint this plugin uses.

## Credits

Provider endpoint and credential-file handling is based on Paseo's own open-source quota-fetcher ([getpaseo/paseo](https://github.com/getpaseo/paseo), Apache-2.0). Kimi, Z.ai, and DeepSeek icon paths come from [Simple Icons](https://simpleicons.org/) and are rendered locally as PNG data URIs. Provider logos are the trademarks of their respective owners, used for identification only.

## License

MIT

## Development

```bash
npm ci
npm run typecheck
npm test
paseo plugin reload usage-remaining
```

Tests use Node.js 22.18+ native TypeScript stripping. They cover paginated agent
bootstrap, live updates, moving/removing agents, teardown races, unavailable usage,
and scoped web style restoration/fallback.
SDK dependencies are pinned to the installed stable Paseo 0.8.0 API; the live docs may
show a newer subscription API that is not yet in that release.
