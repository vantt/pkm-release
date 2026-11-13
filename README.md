# pkm-release

Probes and measurements for [pkm](https://github.com/vantt) that need platforms other than the developer's Linux
machine. No pkm source code lives here.

- `ohs-golden/`: a copy of pkm's `tools/ohs-golden` scripts that measure the OHS baseline
  (`vantt/obsidian-hybrid-search` release bundles, public) on fabricated or public vaults.
- `.github/workflows/ohs-eval.yml`: runs the OHS eval baseline on macOS (arm64 and x64) and uploads the results.
