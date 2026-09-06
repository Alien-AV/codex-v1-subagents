# Codex v1 Subagents

Windows-only runtime patch for Codex desktop that opens subagents as interactive
legacy full-task tabs instead of the non-interactive side panel. It also makes
new tasks use the V1 subagent runtime without leaving a persistent Codex
configuration change.

## One-off run

From npm:

```powershell
npx codex-v1-subagents
```

Or, from a downloaded/cloned copy of this repository:

```powershell
& '.\launch.ps1'
```

The foreground launcher must remain running while Codex is open.

## Install a shortcut

From npm:

```powershell
npx codex-v1-subagents install
```

Or, from a downloaded/cloned copy:

```powershell
& '.\scripts\install.ps1'
```

This copies the current launcher into `%LOCALAPPDATA%\CodexV1Subagents` and
creates **Codex - v1 Subagents** on the Desktop and in the Start Menu. The
shortcut runs that pinned local copy without contacting npm.

Startup failures appear in a dialog and are written to
`%LOCALAPPDATA%\CodexV1Subagents\runtime-patch.log`.

The official Codex shortcut and installed package remain untouched.

## Automatic package updates

To create a shortcut that resolves the newest npm release on every launch:

```powershell
npx codex-v1-subagents install --auto-update
```

That shortcut runs:

```powershell
npx --yes codex-v1-subagents@latest run
```

This mode requires `npx` and internet access when launching Codex. To keep the
pinned local shortcut and update it only when requested, run:

```powershell
npx codex-v1-subagents@latest update
```

## Uninstall

```powershell
npx codex-v1-subagents uninstall
```

You can always launch normal, unpatched Codex using its official shortcut.

## How it works

The launcher starts the unmodified Codex executable with Chromium's private CDP
pipe. It pauses new renderer targets, intercepts two exact JavaScript chunks at
response time, validates their semantic structure, rewrites them in memory, and
then lets Chromium evaluate them.
Existing renderers are reloaded once through the same interceptor.

For the backend, the launcher copies Codex's current full model catalog to a
unique launch directory under `%LOCALAPPDATA%\CodexV1Subagents\runtime` and
changes only catalog entries whose `multi_agent_version` is `v2` to `v1`.

During startup it transactionally adds or replaces these `config.toml` values:

```toml
model_catalog_json = "<generated V1 catalog>"

[features]
multi_agent = true
multi_agent_v2 = false
```

Once Codex is ready, the launcher removes only its changes and preserves
unrelated settings that Codex updated during startup. The original config is
checksummed and backed up beside it for crash recovery. The generated catalog
is validated before use and deleted when Codex exits.

No debugging TCP port is opened and nothing under `WindowsApps` is modified.
Quitting Codex discards the patch.

The catalog choice is persisted in task history. New tasks created under this
launcher use V1; existing tasks that were already created as V2 remain V2.

## Development

```powershell
node --check runtime-patch.cjs
node --check catalog-override.cjs
node --check bin/cli.cjs
node --test runtime-patch.test.cjs
```

## Compatibility

- Tested with OpenAI.Codex `26.825.6671.0`, `26.901.4073.0`,
  `26.901.5003.0`, and `26.901.6511.0`.

The launcher discovers hash-named renderer chunks and checks the exact UI
structure it changes. Harmless package and chunk-hash updates therefore work
automatically. If OpenAI changes or duplicates the relevant logic, the launcher
fails closed instead of guessing.
