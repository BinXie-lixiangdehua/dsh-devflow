# DevFlow

**Version `0.1.0`** · first published snapshot (2026-09-23)

A **multi-agent workflow orchestration plugin for [DeepSeek Harness (dsh)](https://github.com/deepseek-ai/deepseek-harness)**.

DevFlow turns a dsh session into a small delivery organisation with a visible control plane:

- **Roles** — a Commander (总指挥) that plans and dispatches, fixed employees (architect / backend / frontend / code-auditor), and temporary sub-agents created per task.
- **State machine** — dispatch → execution → audit → rework → acceptance. Every step is a persisted business entity under `<workspace>/.devflow`, with an append-only journal.
- **Dispatch plane** — `devflow_*` tools (task / scope / assignment / dispatch / transition / roster), concurrency-capped at 5 with queueing, and a dispatch diagnostic for every hand-off.
- **Visual panel** — a canvas with one edge per dispatch, a roster bar (`fixed / temporary`, live `concurrency N/5`), and a per-node inspector, mounted in the dsh right sidebar.

---

## Requirements

| | |
|---|---|
| Node | `^22.19.0` or `>=24` |
| pnpm | any recent version |
| dsh | installed, with a profile you can edit (e.g. `~/.dsh/profiles/web`) |
| OS | Windows is the tested platform (the preset wires `tool-pwsh` on win32 / `tool-bash` elsewhere) |

## Install (one command)

> The repository is **private** at the moment, so the command below needs your Git credentials.
> Once it is public, anyone can run it as-is.

**Windows (PowerShell)** — copy this single line:

```powershell
git clone https://github.com/BinXie-lixiangdehua/dsh-devflow.git "$env:USERPROFILE\.dsh\local-plugins\dsh-devflow"; & "$env:USERPROFILE\.dsh\local-plugins\dsh-devflow\install.cmd"
```

Or, if you already have the folder, `install.cmd` on its own (double-clickable — it just calls `install.ps1`).

Useful switches:

```powershell
# see what would change, touch nothing
.\install.ps1 -DryRun

# install into a different dsh home / profile, or skip the preset step
.\install.ps1 -DshHome 'C:\Users\me\.dsh' -Profile 'web'
.\install.ps1 -SkipPreset

# install a specific tag/branch
.\install.ps1 -Ref 'v0.1.0'
```

## What the installer actually changes

It touches **exactly four things**, and backs up every file it rewrites:

1. **Puts the plugin on disk** — clones (or copies) into `~/.dsh/local-plugins/dsh-devflow` by default.
2. **Registers the profile bundle** — in `~/.dsh/profiles/<profile>/package.json`:
   adds `"@xiaoxie-ide/dsh-devflow": "link:<install-dir>"` to `dependencies` and the package name to `dsh.profile.bundles`.
   The original file is saved as `package.json.bak-devflow-<timestamp>`.
3. **Links dependencies** — runs `pnpm install` inside the profile so the `link:` symlink really exists.
4. **Deploys the agent preset** — copies `presets/devflow/{agent.cordis.yml, preset.yml}` to `~/.dsh/.agent-presets/devflow/`,
   rewriting the activation row from the checkout-relative path to an absolute `file:///.../lib/host/preset-activation.js?rev=<sha>` URL.

Then **restart dsh**, open a session, and pick the **DevFlow** preset. That is the whole install.

> Why the `?rev=` token: a standing mount re-imports a row only when its stamp changes, and an unchanged URL is served from the ESM module cache. Bumping `rev` after a rebuild is what lets the running host pick up a new `lib/` without a restart.

## Manual install

If you prefer doing it by hand:

```powershell
# 1. get the code where you want it
git clone https://github.com/BinXie-lixiangdehua/dsh-devflow.git D:\plugins\dsh-devflow

# 2. register it in the profile (edit ~/.dsh/profiles/web/package.json)
#    dependencies:  "@xiaoxie-ide/dsh-devflow": "link:D:\\plugins\\dsh-devflow"
#    dsh.profile.bundles: add "@xiaoxie-ide/dsh-devflow"

# 3. materialise the link
pnpm install --dir "$env:USERPROFILE\.dsh\profiles\web"

# 4. deploy the preset, pointing row 1 at the checkout you just cloned
#    copy presets\devflow\*.yml  ->  ~/.dsh/.agent-presets/devflow/
#    in agent.cordis.yml replace:  ../../lib/host/preset-activation.js
#    with:                         'file:///D:/plugins/dsh-devflow/lib/host/preset-activation.js?rev=local'
```

## Build from source

`lib/` is committed on purpose so that installing needs no toolchain. If you change `src/`, rebuild and re-commit the artefacts:

```bash
pnpm install
pnpm typecheck   # tsc, both projects
pnpm build       # tsc + tsdown  ->  lib/index.js, lib/client.js
pnpm check       # node --check on both bundles
pnpm test        # vitest
```

Gate order matters: `typecheck → build → check → test` (`check` inspects `lib/`, so running it before `build` checks a stale bundle).

After a rebuild, bump the `?rev=` token in the deployed preset, or restart dsh, to make the host load the new module.

## Uninstall

1. Remove `~/.dsh/.agent-presets/devflow/`.
2. Undo step 2 above: drop the dependency line and the `dsh.profile.bundles` entry (or restore `package.json.bak-devflow-<timestamp>`).
3. `pnpm install` in the profile again, then delete the plugin folder.

`.devflow` directories live **inside your project workspaces**, not in this repository. They are your project state — remove them yourself if you want a clean slate.

## Layout

```
src/host/          plugin host plane: tools, state machine, storage, journal, guards
src/client/        the panel: canvas, projection, roster, sidebar slot
presets/devflow/   the dsh agent preset (activation row + capability rows)
tests/             vitest suites (unit + guard/isolation)
lib/               built bundles — committed for zero-build installs
cordis.patch.yml   the dsh bundle patch
install.ps1/.cmd   the one-command installer described above
```

## Versioning

`0.x` while the plugin is still moving. Every published snapshot gets an annotated tag (`v0.1.0`, `v0.1.1`, …) and the `version` field in `package.json` matches that tag, so `git checkout v0.1.0` and a pinned install both mean the same thing.

## License

MIT — see [LICENSE](LICENSE).
