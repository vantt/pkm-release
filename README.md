# pkm-release

Probes and measurements for [pkm](https://github.com/vantt) that need platforms other than the developer's Linux
machine. No pkm source code lives here; `pkm-eval` checks the private source out at run time with a read-only token
and uploads only eval results.

- `ohs-golden/`: a copy of pkm's `tools/ohs-golden` scripts that measure the OHS baseline
  (`vantt/obsidian-hybrid-search` release bundles, public) on fabricated or public vaults.
- `.github/workflows/ohs-eval.yml`: runs the OHS eval baseline on macOS arm64 and Windows x64 (OHS ships no darwin-x64 bundle),
  `mode` hybrid or fulltext.
- `.github/workflows/pkm-eval.yml`: pkm's search quality gate (G4) on macOS arm64 and Windows x64 against the OHS baseline
  of the same platform; needs the `PKM_READ_TOKEN` secret (fine-grained, `vantt/pkm`, Contents: read). Corpora come from
  `ohs-golden/eval/corpora.mjs`; Windows links the ONNX Runtime built by `ort-build-win` (same cache key).
- `ort-probe/`, `.github/workflows/ort-probe.yml`: builds ONNX Runtime (via the `ort` crate) statically on linux-x64, win32-x64 (static CRT), darwin-arm64 and darwin-x64, loads multilingual-e5-small and compares token ids and vectors with the transformers.js golden.
