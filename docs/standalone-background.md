# Standalone background execution

The exact SDK target is **Pi 0.85.1**, matching the unmodified `pi-gigachat` 0.6.4 provider. The standalone verification target is its **official Linux x64 release**; keep the adjacent release assets with the executable. A previous 0.86.1 receipt does not validate 0.85.1. The pinned archive and loader capability have been inspected, but the 0.85.1 Linux lifecycle matrix must pass before standalone execution can be called validated. Other versions, operating systems, architectures and packagers are not validated.

Pi 0.85.1's extension loader exposes its embedded SDK through virtual modules. This is the required seam for `binary-bootstrap.ts`, which awaits the existing configured runner before exiting; it does not require a 0.86-only SDK API. Startup authorization, revival leases, controls, disposal and process-close observation remain shared with npm. Each independent run has its own host; native sessions inside that run share it. No per-session CLI protocol, runtime download/install, alternate SDK or foreground fallback is introduced. Npm Pi keeps its Node runner, peer aliases and detected npm `PI_PACKAGE_DIR` override (including refusal when no npm root exists).

Implementation and lifecycle fixtures derive from [@xz-dev](https://github.com/xz-dev)'s [PR #2049](https://github.com/nicobailon/pi-subagents/pull/2049), source commit `910807bfefcf9ee41d73fa25ec86dcd75ab8f4b2` (Xiangzhe, `xiangzhedev@gmail.com`). The lifecycle coverage is retained against the pinned SDK; provenance is not proof of a passing matrix on this integration snapshot.

## Experimental Windows host recognition

The resolver recognizes Bun's Windows virtual entrypoint prefixes, `B:/~BUN/` and `B:\~BUN\`, alongside `/$bunfs/`. It launches the real `process.execPath` (or the existing executable override). The `B:` prefix is virtual, not the installation drive; `pi-native.exe` is not a required executable name.

Windows recognition remains **experimental**, not a supported standalone verification target: the full 0.85.1 lifecycle matrix has not been validated there or for every Bun-compiled Pi host.

Node-hosted npm Pi keeps its existing runner path and is not affected by this virtual-entrypoint detection defect. Installing only the pi-subagents extension through npm does not change a Bun-compiled Pi host into an npm Pi host.

## Official binary gate

On Linux x64 with Node, npm, tar and bubblewrap installed, provision dependencies and the checksum-pinned release separately from execution:

The [official 0.85.1 release metadata](https://api.github.com/repos/earendil-works/pi/releases/tags/v0.85.1) identifies the archive SHA-256 as `494e498f47d74d21f40b3386f6a5e921a3d49531a169cab55bbdaca0ea1fe25a`. The executable SHA-256, computed from that downloaded archive without executing it, is `443bd83f30e4dbc7bac2eed9c6aa2461b9a15016fd555f48c92a0591d028c403`. These identities are recorded in `test/smoke/standalone-release.json`; they are not runtime-success receipts.

```bash
npm ci --ignore-scripts
release_dir="$(mktemp -d)"
url="$(node -p 'require("./test/smoke/standalone-release.json").url')"
sha="$(node -p 'require("./test/smoke/standalone-release.json").archiveSha256')"
curl --fail --location --retry 3 "$url" --output "$release_dir/release.tar.gz"
printf '%s  %s\n' "$sha" "$release_dir/release.tar.gz" | sha256sum --check -
tar -xzf "$release_dir/release.tar.gz" -C "$release_dir"
node test/smoke/standalone-matrix.mjs "$release_dir/pi/pi" "$(mktemp -d)/matrix"
```

The `official-standalone` CI job runs this gate against 0.85.1. Both archive and executable hashes are pinned, and the executable must report the pinned version. Each of 18 modes gets a fresh stage with no filesystem core SDK/shim, empty installation caches and isolated network/PID namespaces. Bare-Bun SDK import must fail; accepted execution uses Pi's actual loader. Missing sandbox support or running on a different platform fails rather than producing a skipped success. Use disk-backed storage: retained stages can occupy several GiB. Darwin cannot run this Linux x64/bubblewrap gate; a Linux CI receipt remains required.

The matrix exercises public launch/notification, workflows, same-run concurrent sessions, parallel stop, targeted steer/interrupt, child/tool/run deadlines, missing bootstrap, post-spawn persistence/authorization failures, SDK initialization failure, malformed bootstrap input/EOF with an authorized positive control, and competing revival. The provider is deterministic, but SDK sessions, runner and public extension are real. Only startup-failure writes are faulted.

`matrix.json` records complete/partial results with per-mode durations; `inputs.json` freezes source identities. The candidate is built and packed once and every mode must use that package hash. Modes run one at a time; they are CPU-bound and miss their deadlines when run concurrently. Inspect per-mode logs, `identity.json`, lifecycle/notification evidence, `status.json` and `process-terminal.json`. A persisted result is not exit proof: the gate separately awaits observed close, verifies dead PIDs before sandbox teardown and checks session shutdown/lease release. CI retains receipts and at most 32 MiB compressed lifecycle evidence. Contributor-head passes do not establish acceptance for a different integration snapshot.

For a focused diagnostic, use `node test/smoke/standalone-background.mjs "$release_dir/pi/pi" "$(mktemp -d)/check" bootstrap-errors` (or another matrix mode). A focused pass is not the complete gate.

## Npm regressions and local trial

Clean-install CI provisions all four SDK packages at exactly 0.85.1 and TypeBox at 1.3.7. Its host and extension installs remain separate, and peer aliases must resolve inside the host installation. Native nested-wait checks use the same pins and the native peer loader rather than a shim or a second SDK identity. The former native MCP readiness job required Pi 1.2.0; it is not a valid 0.85.1 gate because this SDK does not export the built-in MCP factory.

The Linux standalone CI job also checks the public npm launch path without execution-time network. It deliberately invokes the host's unbundled `dist/cli.js`, keeping the parent and detached Node runner on the same modular SDK; this is not evidence for every bundled npm CLI entrypoint:

```bash
npm_checks="$(mktemp -d)"
node --experimental-strip-types test/smoke/clean-install.mjs "$npm_checks/sdk" 0.85.1
node test/smoke/npm-background.mjs "$npm_checks/sdk" "$npm_checks/launch"
```

On Darwin, run the clean-install command alone to exercise the real pinned npm SDK and host module identity. The second command requires Linux x64 and bubblewrap. Inspect `child.log`, `packed-selection.log`, `aliases.json` and, for Linux public launch, `npm-launch.json` and `parent.log`; a clean-install pass does not establish standalone acceptance.

To try a checkout without replacing your installation on the Linux standalone verification target, start a separate Pi 0.85.1 process with an isolated agent directory:

```bash
PI_CODING_AGENT_DIR="$(mktemp -d)" "$release_dir/pi/pi" \
  --no-extensions --no-skills --no-prompt-templates --extension "$PWD/index.ts"
```

This command targets a source checkout. The published npm package uses the compiled `index.js` entry instead.

Configure a provider in that isolated session, ask for a read-only background child and inspect its notification/run artifacts. This loads only the checkout for that process; it does not install the candidate or reuse normal credentials. Keep the parent alive for notifications.
