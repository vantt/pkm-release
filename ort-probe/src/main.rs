//! Probe for pkm's ORT decision: build `ort` statically or dynamically, load multilingual-e5-small (q8), embed the
//! fabricated texts of pkm's golden (`golden/vectors.jsonl`, recorded from OHS / transformers.js) and report token-id
//! equality, cosine to the golden vectors, timings, RSS and binary size as one JSON object on stdout.
//!
//!   ort-probe <model dir> [threads,...]

use std::path::Path;
use std::time::Instant;

use ndarray::Array2;
use ort::session::Session;
use ort::session::builder::GraphOptimizationLevel;
use ort::value::TensorRef;
use serde_json::{Value, json};
use tokenizers::Tokenizer;

type Res<T> = Result<T, Box<dyn std::error::Error>>;

fn rss() -> Option<usize> {
    memory_stats::memory_stats().map(|m| m.physical_mem)
}

fn session(env: &ort::environment::Environment, model: &Path, threads: usize) -> Res<Session> {
    Ok(Session::builder(env)?
        .with_optimization_level(GraphOptimizationLevel::Level3)?
        .with_intra_threads(threads)?
        .commit_from_file(model.join("onnx/model_quantized.onnx"))?)
}

fn embed(s: &mut Session, ids: &[u32]) -> Res<Vec<f32>> {
    let n = ids.len();
    let input = Array2::from_shape_vec((1, n), ids.iter().map(|&x| x as i64).collect())?;
    let mask = Array2::<i64>::ones((1, n));
    let types = Array2::<i64>::zeros((1, n));
    let outputs = s.run(ort::inputs![
        "input_ids" => TensorRef::from_array_view(&input)?,
        "attention_mask" => TensorRef::from_array_view(&mask)?,
        "token_type_ids" => TensorRef::from_array_view(&types)?,
    ])?;
    let hidden = outputs[0].try_extract_array::<f32>()?;
    let dims = hidden.shape()[2];
    let mut v = vec![0f32; dims];
    for t in 0..n {
        for d in 0..dims {
            v[d] += hidden[[0, t, d]];
        }
    }
    let norm = v.iter().map(|x| (*x / n as f32).powi(2)).sum::<f32>().sqrt();
    Ok(v.iter().map(|x| (*x / n as f32) / norm).collect())
}

fn main() -> Res<()> {
    let args: Vec<String> = std::env::args().collect();
    let model = Path::new(args.get(1).ok_or("usage: ort-probe <model dir> [threads,...]")?);
    let threads: Vec<usize> = args
        .get(2)
        .map(|s| s.split(',').map(|x| x.parse().unwrap()).collect())
        .unwrap_or_else(|| vec![1, 4]);
    let rss0 = rss();
    #[cfg(not(feature = "dynamic"))]
    let env = ort::init().build()?;
    #[cfg(feature = "dynamic")]
    let env = ort::init_from(std::env::var("ORT_DYLIB_PATH").map_err(|_| "set ORT_DYLIB_PATH")?)?.build()?;
    let t0 = Instant::now();
    let tokenizer = Tokenizer::from_file(model.join("tokenizer.json")).map_err(|e| e.to_string())?;
    let tokenizer_ms = t0.elapsed().as_secs_f64() * 1e3;

    let t1 = Instant::now();
    let mut s = session(&env, model, threads[0])?;
    let session_ms = t1.elapsed().as_secs_f64() * 1e3;
    let rss_loaded = rss();

    // Golden comparison.
    let golden = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("golden/vectors.jsonl"))?;
    let mut rows = Vec::new();
    let (mut min_cos, mut ids_equal, mut compared) = (1f64, 0usize, 0usize);
    for line in golden.lines() {
        let g: Value = serde_json::from_str(line)?;
        let prepared = g["prepared"].as_str().unwrap();
        let enc = tokenizer.encode(prepared, true).map_err(|e| e.to_string())?;
        let ids = enc.get_ids();
        let want: Vec<u32> = g["token_ids"].as_array().unwrap().iter().map(|x| x.as_u64().unwrap() as u32).collect();
        let same = ids == want.as_slice();
        if same {
            ids_equal += 1;
        }
        let mut cos = None;
        if let Some(gv) = g["vector"].as_array() {
            // OHS sends passages over 506 tokens back as input_too_long, queries are cut at 512 by transformers.js.
            let n = ids.len().min(512);
            let v = embed(&mut s, &ids[..n])?;
            let c: f64 = v.iter().zip(gv).map(|(a, b)| *a as f64 * b.as_f64().unwrap()).sum();
            min_cos = min_cos.min(c);
            compared += 1;
            cos = Some(c);
        }
        rows.push(json!({"id": g["id"], "type": g["type"], "tokens": ids.len(), "ids_equal": same, "cosine": cos}));
    }

    // Timing: a 16-token query and a 256-token passage, per thread count.
    let q = tokenizer.encode("query: kế hoạch bán hàng quý ba của nhóm thiết kế", true).map_err(|e| e.to_string())?;
    let p_text = format!("passage: {}", "Biên bản họp khách hàng về hợp đồng dịch vụ. ".repeat(30));
    let p = tokenizer.encode(p_text.as_str(), true).map_err(|e| e.to_string())?;
    let p_ids = &p.get_ids()[..256.min(p.get_ids().len())];
    let mut timing = Vec::new();
    for &t in &threads {
        let t_make = Instant::now();
        let mut st = session(&env, model, t)?;
        let make_ms = t_make.elapsed().as_secs_f64() * 1e3;
        embed(&mut st, q.get_ids())?;
        let reps = 20;
        let a = Instant::now();
        for _ in 0..reps {
            embed(&mut st, q.get_ids())?;
        }
        let query_ms = a.elapsed().as_secs_f64() * 1e3 / reps as f64;
        let b = Instant::now();
        for _ in 0..5 {
            embed(&mut st, p_ids)?;
        }
        let passage_ms = b.elapsed().as_secs_f64() * 1e3 / 5.0;
        timing.push(json!({"threads": t, "session_ms": make_ms, "query_tokens": q.get_ids().len(), "query_ms": query_ms,
            "passage_tokens": p_ids.len(), "passage_ms": passage_ms}));
    }

    let exe = std::env::current_exe()?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "target": format!("{}-{}", std::env::consts::ARCH, std::env::consts::OS),
            "linking": if cfg!(feature = "dynamic") { "dynamic" } else { "static" },
            "binary_bytes": std::fs::metadata(&exe)?.len(),
            "tokenizer_ms": tokenizer_ms,
            "session_ms": session_ms,
            "rss_before": rss0,
            "rss_loaded": rss_loaded,
            "golden": {"rows": rows.len(), "ids_equal": ids_equal, "compared": compared, "min_cosine": min_cos},
            "timing": timing,
            "rows": rows,
        }))?
    );
    Ok(())
}
