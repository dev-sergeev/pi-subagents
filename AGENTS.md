# Repository Guidelines

## Project Overview

pi-subagents is a Pi extension for supervised delegation: one parent session launches focused children, orchestrates workflows, and retains control and acceptance of results.

**Read [VISION.md](VISION.md) before product, architecture, scope, or backlog-disposition decisions.** It is the project acceptance policy. Compose existing primitives before adding surfaces; prefer clean cutovers over compatibility paths. Completion requires evidence, background work must stay visible, and status/watch hot-path costs must be justified. Broad launch, public API, persistence, or runner-lifecycle changes need approval.

## Architecture & Data Flow

- `index.ts` selects normal extension registration or the Herdr bridge; native child processes skip normal registration.
- `src/extension/index.ts` is the composition root: parent-owned state, tool registration, injected executor/watchers, and teardown. Public requests are normalized through `src/extension/public-execution.ts`.
- Workflow scripts execute in workers through `src/workflows/scripted-workflow.ts`; injected host callbacks perform actual launches, status/control operations, and persistence.
- Native children share `src/runs/shared/child-launch.ts` and `child-session.ts`. Foreground sessions run inside the parent process; background sessions run inside detached runner processes.
- Detached flow: serialize launch contract → `async-execution.ts` → `subagent-runner-bootstrap.ts` → `subagent-runner.ts` → durable status/events/results → watcher and parent delivery.
- External CLI/job adapters have explicit capability contracts; do not assume native Pi context, events, or extensions. A completed detached child does not itself prove its parent-hosted workflow continuation succeeded.

## Key Directories

| Path | Responsibility |
| --- | --- |
| `src/extension/`, `src/api/` | Runtime composition/public tools; extension integration contracts and exports. |
| `src/runs/{foreground,background,shared}/` | Execution, detached lifecycle, shared launch/session/control contracts. |
| `src/workflows/`, `src/missions/` | Script orchestration/resources/settlement; durable mission lifecycle. |
| `src/agents/`, `src/profiles/` | Agent discovery/configuration and profiles. |
| `src/shared/` | Shared contracts, atomic persistence, filesystem leases, identity and coordination. |
| `src/tui/`, `src/slash/`, `src/intercom/` | UI projections, command entry points, supervision/result transport. |
| `agents/`, `prompts/`, `skills/` | Shipped agent definitions, user-invoked prompt templates, on-demand skills. |
| `test/{unit,integration,smoke,support,fixtures}/` | Behavioral checks, local SDK smoke, harnesses and fixtures. |
| `docs/`, `examples/typed-gate/` | Reference documentation and runnable typed-gate example. |

## Development Commands

Use Node 24 and npm, matching primary CI.

```sh
npm ci --ignore-scripts             # CI dependency installation
npm run typecheck                  # production TypeScript; excludes tests
npm test                           # unit tests only
npm run test:integration
npm run test:all                    # unit + integration; excludes smoke
npm run test:smoke:tool-activation  # local Pi SDK with faux provider
npm run build:pkg                  # recreate compiled dist-pkg/
npm run pack:pkg                   # build and pack dist-pkg/
npx oxlint .                       # configured linter; no npm lint script
```

There is no generic `build`, `dev`, or formatter script. Source checkout execution needs no build: load it in Pi with `pi --extension ./index.ts`. Canonical packaged installation is `pi install npm:@dev-sergeev/pi-subagents`.

## Code Conventions & Common Patterns

- Strict TypeScript ESM, ES2023/NodeNext, `noUncheckedIndexedAccess`. Follow surrounding tabs, double quotes, and semicolons; kebab-case filenames, camelCase functions, PascalCase types. Use `node:` built-ins and type-only imports. Source relative imports use `.ts`.
- Reuse typed dependency bags/factories: `createSubagentExecutor(deps)`, `ChildSessionFactory`, workflow host callbacks, and injected watcher filesystem/timer/notifier dependencies.
- State ownership is explicit: registration owns `SubagentState`; executors and watchers receive it. Preserve session ownership and idempotent reload cleanup; some runtime registration deliberately uses `globalThis`.
- Propagate `AbortSignal` through workflows and launches. Dispose sessions, remove listeners, and clear timers during settlement/teardown.
- Validate untrusted values at public and process boundaries. Keep public requests distinct from internal launch/provenance fields.
- Preserve error causes, failure classification, partial outputs, and trace evidence. Best-effort telemetry must not turn successful work into failure; authoritative execution failures must remain visible.
- Reuse `src/shared/atomic-json.ts` and existing leases/coalescers/result-file helpers rather than inventing competing persistence or polling paths.
- Do not impose fictional directory-layer rules: the executor intentionally composes extension, workflow, mission, API, and inspector modules.

## Important Files

- `package.json`, `package-lock.json`, `.npmrc`: commands, public exports, pinned dependencies; `save-exact=true`.
- `tsconfig.json`, `tsconfig.build.json`, `.oxlintrc.json`, `tools/oxlint/`: compiler and lint contracts.
- `scripts/build-package.mjs`: release assembly; generates manifest/exports and copies every root `.mjs`. Never edit `dist-pkg/` as source or leave throwaway root `.mjs` files.
- `src/runs/foreground/subagent-executor.ts`: execution orchestration and workflow host.
- `src/runs/background/result-watcher.ts`, `result-files.ts`: durable completion and delivery.
- `src/shared/types.ts`, `src/agents/agents.ts`: shared runtime contracts and agent discovery.
- `docs/configuration.md`, `docs/agents.md`, `docs/workflows.md`, `docs/extension-api.md`: configuration, agent definitions, workflows, public API. `docs/gigachat-compatibility-spec.md` describes proposed requirements, not implemented behavior.
- `.github/workflows/test.yml`, `release.yml`: broader QA and release gates. Update relevant reference docs and `CHANGELOG.md` for permanent behavior changes.

## Runtime/Tooling Preferences

- npm lockfile is authoritative; Bun is optional compatibility coverage, not the default runtime/package manager. No root `engines` field is declared; locked Undici requires Node ≥22.19.0. Prefer CI's Node 24.
- Real execution uses the host Pi SDK peers. Preserve host module identity and runner peer-loader/bootstrap behavior; bare Bun is not a replacement for Pi's embedded SDK.
- Source root is private; package/publish only generated `dist-pkg/`. Maintain lazy heavy-runner imports: packaging explicitly checks bootstrap laziness.
- `/reload` can refresh discovered agents/settings, but replacing already-loaded extension modules requires restarting Pi. Pi 0.85.1 sessions use current tool schemas; activation selection is branch-local custom state, not declaration pinning.

## Testing & QA

Tests use `node:test` and `node:assert/strict`, with native TypeScript stripping. Keep the harness preload when selecting a single file:

```sh
node --experimental-strip-types --import ./test/support/isolated-temp-root.mjs --test test/unit/<name>.test.ts
node --experimental-strip-types --import ./test/support/register-loader.mjs --test test/integration/<name>.test.ts
```

Runner options such as `--test-name-pattern="pattern"` go before the file. Appending a path to `npm run test:unit` does not replace its existing all-unit glob.

- Use temporary isolated homes/repositories and existing support factories. Unit tests can invoke Git; integration tests can spawn local runners and write artifacts.
- Ordinary integration fixtures use scripted child sessions. External Claude/Codex/Cursor maintainer smokes require explicit environment flags, report paths, and authenticated CLIs; do not enable them as routine local checks.
- Tool activation smoke uses a real Pi session with a faux provider and model networking disabled. Run it for registration/schema changes.
- Prove current behavior, boundaries, cancellation, ownership, and settlement—not removed compatibility contracts. No configured coverage percentage is prescribed.
- Run focused behavioral checks plus relevant typecheck/integration/package checks. CI also exercises cross-platform, SDK, loader, Bun parity, and standalone/package paths beyond `test:all`.
