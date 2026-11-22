<#
Chạy các phần kiểm của pkm-release trên một máy Windows của người dev (chưa kiểm trên máy thật khi viết; xem README).
  -PkmSrc  thư mục checkout của vantt/pkm
  -Mode    test   : cargo test --workspace (ORT dựng sẵn của pyke, CRT động)
           binary : dựng pkm.exe release, in dumpbin /dependents, chạy `pkm --version`
                    (đặt ORT_LIB_LOCATION tới thư mục có onnxruntime.lib CRT tĩnh để dựng đúng cấu hình phát hành;
                     không đặt thì dựng với CRT động và dumpbin sẽ báo CRT động, đó là điều mong đợi)
           eval   : cổng G4 (search-eval) so với mốc OHS win32-x64; cần node, git, curl; đặt -ReleaseRepo là
                    thư mục checkout repo này
  -Work    thư mục làm việc (log, corpus, model, kết quả)
Log đầy đủ ở $Work; màn hình chỉ in dòng tổng kết.
#>
param(
  [Parameter(Mandatory)][string]$PkmSrc,
  [ValidateSet('test', 'binary', 'eval')][string]$Mode = 'test',
  [string]$ReleaseRepo = (Split-Path -Parent $PSScriptRoot),
  [string]$Work = "$env:TEMP\pkm-win-local"
)
$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force $Work | Out-Null
$PkmSrc = (Resolve-Path $PkmSrc).Path

function Use-VsEnv {
  $vs = & "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe" -latest -property installationPath
  cmd /c "`"$vs\VC\Auxiliary\Build\vcvars64.bat`" && set" | ForEach-Object {
    if ($_ -match '^([^=]+)=(.*)$') { Set-Item -Path "env:$($Matches[1])" -Value $Matches[2] }
  }
}

Push-Location $PkmSrc
try {
  switch ($Mode) {
    'test' {
      if (-not $env:ORT_LIB_LOCATION) { $env:RUSTFLAGS = '-C target-feature=-crt-static' }
      $env:PKM_NO_OHS = '1'
      cargo fetch --locked *> "$Work\fetch.log"
      cargo test --workspace --locked --no-fail-fast *> "$Work\test.log"
      $code = $LASTEXITCODE
      Select-String -Path "$Work\test.log" -Pattern '^test result:| \.\.\. FAILED$|^error(\[E\d+\])?: ' | ForEach-Object { $_.Line }
      "cargo test exit $code (log: $Work\test.log)"
      exit $code
    }
    'binary' {
      if (-not $env:ORT_LIB_LOCATION) { $env:RUSTFLAGS = '-C target-feature=-crt-static' }
      cargo build --release --locked -p pkm *> "$Work\build.log"
      if ($LASTEXITCODE -ne 0) { Select-String -Path "$Work\build.log" -Pattern '^error' | Select-Object -First 20 | ForEach-Object { $_.Line }; exit 1 }
      Use-VsEnv
      $out = & dumpbin.exe /dependents target\release\pkm.exe
      $out | Select-String '\.dll' | ForEach-Object { $_.Line.Trim() }
      $bad = $out | Select-String -Pattern '(?i)vcruntime|msvcp|ucrtbase|api-ms-win-crt'
      if ($bad) { 'CRT động còn nhập:'; $bad } else { 'không nhập CRT động' }
      .\target\release\pkm.exe --version
      .\target\release\pkm.exe version --json
    }
    'eval' {
      if (-not $env:ORT_LIB_LOCATION) { $env:RUSTFLAGS = '-C target-feature=-crt-static' }
      $ohsCommit = '294902225b903113ff089bf63af5c8aa1fc8a50d'
      $modelCommit = '761b726dd34fb83930e26aab4e9ac3899aa1fa78'
      git config --global core.autocrlf false
      $ohs = "$Work\ohs"; $otf = "$Work\otf"
      if (-not (Test-Path $ohs)) {
        git init -q $ohs
        git -C $ohs fetch -q --depth 1 https://github.com/vantt/obsidian-hybrid-search.git $ohsCommit
        git -C $ohs checkout -q --detach FETCH_HEAD
      }
      if (-not (Test-Path $otf)) {
        git clone -q https://github.com/vantt/obsidian-test-fixture $otf
        git -C $otf checkout -q v0.12.0
      }
      node "$ReleaseRepo\ohs-golden\eval\corpora.mjs" --ohs-repo $ohs --otf $otf --out "$Work\corpora"
      $m = "$Work\models\Xenova--multilingual-e5-small@$modelCommit"
      New-Item -ItemType Directory -Force "$m\onnx" | Out-Null
      foreach ($f in 'config.json', 'tokenizer.json', 'tokenizer_config.json', 'special_tokens_map.json', 'onnx/model_quantized.onnx') {
        if (-not (Test-Path "$m\$f")) {
          Invoke-WebRequest -UseBasicParsing -OutFile "$m\$f" "https://huggingface.co/Xenova/multilingual-e5-small/resolve/$modelCommit/$f"
        }
      }
      cargo build --release --locked -p pkm-search-eval --features run *> "$Work\build.log"
      if ($LASTEXITCODE -ne 0) { Select-String -Path "$Work\build.log" -Pattern '^error' | Select-Object -First 20 | ForEach-Object { $_.Line }; exit 1 }
      $E = "target\release\search-eval.exe"
      $B = "tools\parity\golden\ohs\eval\win32-x64"
      $corpora = Get-Content "$Work\corpora\corpora.json" -Raw | ConvertFrom-Json
      New-Item -ItemType Directory -Force "$Work\out\run", "$Work\work" | Out-Null
      foreach ($c in 'vi-search', 'smoke', 'obsidian-help', 'de') {
        foreach ($mode in 'hybrid', 'fulltext') {
          $base = if ($mode -eq 'fulltext') { "$B\fulltext" } else { $B }
          if (-not (Test-Path "$base\$c\per-query.jsonl")) { "$c $mode`: không có mốc, bỏ qua"; continue }
          & $E run --corpus $c --vault $corpora.$c.vault --pack $corpora.$c.pack --baseline $B `
            --model-root "$Work\models" --out "$Work\out\run" --work "$Work\work" --mode $mode
        }
      }
      (Get-CimInstance Win32_Processor | Select-Object -First 1).Name | Tee-Object "$Work\out\cpu.txt"
      & $E compare --baseline $B --run "$Work\out\run" --strict --json "$Work\out\compare.json" --md "$Work\out\compare.md"
      $code = $LASTEXITCODE
      Select-String -Path "$Work\out\compare.md" -Pattern '^\| ' | Select-Object -First 40 | ForEach-Object { $_.Line }
      "compare exit $code (kết quả: $Work\out; mốc ghi trên AMD EPYC 7763, CPU khác có thể trượt q011 và vi-dd)"
      exit $code
    }
  }
} finally { Pop-Location }
