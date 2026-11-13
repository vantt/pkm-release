# pkm-release

Probes and measurements for [pkm](https://github.com/vantt) that need platforms other than the developer's Linux
machine. No pkm source code lives here.

- `ohs-golden/`: a copy of pkm's `tools/ohs-golden` scripts that measure the OHS baseline
  (`vantt/obsidian-hybrid-search` release bundles, public) on fabricated or public vaults.
- `.github/workflows/ohs-eval.yml`: runs the OHS eval baseline on macOS arm64 and Windows x64 (OHS ships no darwin-x64 bundle).
- `ort-probe/`, `.github/workflows/ort-probe.yml`: builds ONNX Runtime (via the `ort` crate) statically on linux-x64, win32-x64 (static CRT), darwin-arm64 and darwin-x64, loads multilingual-e5-small and compares token ids and vectors with the transformers.js golden.
