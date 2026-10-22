# Horizon local reranker versus Sno GPU reranker

> **Updated measured proposal:** [optimized local and GPU reranking](../rerank-optimized-2026-10-21/README.md). The historical stage-only tables below do not include final product diversity scoring.

> **2026-10-21 correction — historical replay, not a model-selection conclusion.** The retained English and Chinese candidate pools contain real retrieval hits whose missing fusion/vector/keyword scores were filled with zero by the original `fill-texts.py`. Their blend replay therefore does not reproduce complete product inputs. The cross-language pool has no filled records and independently exhibits harmful score blending. Local q8 predictions also change with batch composition, so restricting cap64 predictions is not an actual cap15 execution. The earlier decision and unoptimized comparison below must not be used to choose a backend; both pipelines are now being optimized under equal conditions, using complete cosine values, the original evidence labels and metrics, and literal finalist inference.

Measured: 2026-10-20T08:04:44.412808-07:00 (Pacific time).

## Decision

Do not treat the current GPU score-blend result as the quality of the GPU model. The GPU model ranks better than Horizon small on this evaluation, especially for Chinese questions retrieving English memories. The current blend formula substantially degrades those rankings. Local reranking is close on Chinese-only queries, but is not a lossless replacement across all language conditions.

The expected speed gain from removing a network call is not established: on the measured Linux host, the loaded local model is slower than the public GPU route. The Mac measurement covers GPU network waiting only; its local model runtime was unavailable, so no Mac local-versus-GPU speed claim is made.

## Exact models and existing evaluation

- Local: `Horizon-Labs/multilingual-reranker-small`, deployed as `sno-lab/multilingual-reranker-small-int8`, pinned revision in `result.json`. This is a cross-encoder over the locally selected first 15 memories, not merely the local vector/keyword ranking. Production `LocalReranker.score` was invoked for every scored question, using its actual tokenizer, length-based ordering, batches of five and ONNX weights.
- GPU: live health and container inspection identify `ettin-reranker-400m-v1` at `https://rt3-llm.sno.ai/rerank`. It is not the Qwen model named in the older study notes.
- Reused the original `evals/rerank-cpu` study: retained `rr/pools-{en,zh,xl}.json`, `depth/*-blend.json`, and the original `depth/evaluate.py`. The evaluation and its inference scripts were located in the original retained session artifacts and recovered under the raw-artifact directory in `result.json`. No new questions, evidence labels, LLM judge or replacement metric were authored.
- Original LoCoMo data have 1,540 questions per variant. Four lack evidence-memory labels; the same four are excluded from both sides. All 1,536 remaining questions per variant have complete current local and GPU results: 4,608 paired observations. The translated variants share questions and are not independent datasets.
- The first 300 current-product observations were reused; remaining questions were scored once. Historical Horizon scores were checked but are not used as the final local result. Quality scoring used one or four CPU threads to finish independent queries; timed product replay used four threads. No batch-scoring duration is used as query latency.

## Quality: correct evidence memory appears within the first five

| Query / memory language | Horizon local 15 | GPU same 15 | GPU model 64 | Current GPU blend formula 64 |
|---|---:|---:|---:|---:|
| English question / English memory | 75.20% | 78.65% | 81.71% | 59.24% |
| Chinese question / Chinese memory | 61.91% | 62.04% | 63.09% | 30.47% |
| Chinese question / English memory | 68.36% | 71.09% | 78.65% | 60.03% |

GPU-model advantage over local, percentage points:

| Language condition | Same 15 candidates | GPU 64 versus local 15 |
|---|---:|---:|
| English question / English memory | +3.45 | +6.51 |
| Chinese question / Chinese memory | +0.13 | +1.17 |
| Chinese question / English memory | +2.73 | +10.29 |

Most of the cross-language gap comes from candidate reach: the local model cannot recover an answer outside its first 15. Keeping the same 15 makes the model-only difference much smaller. GPU “same 15” restricts its observed 64-candidate scores to the local model’s 15; it is not an additional full-dataset set of 15-candidate HTTP calls. The timing replay separately sends real 15-candidate GPU requests.

## Correct evidence memory ranked first

| Language condition | Horizon local 15 | GPU same 15 | GPU model 64 | Current GPU blend formula 64 |
|---|---:|---:|---:|---:|
| English question / English memory | 55.21% | 61.39% | 62.70% | 35.35% |
| Chinese question / Chinese memory | 47.33% | 48.37% | 48.89% | 19.08% |
| Chinese question / English memory | 47.27% | 53.65% | 56.25% | 32.16% |

Full R@3/R@5/R@10, reciprocal-rank and normalized-discounted-gain measurements, including baseline and historical-score checks, are in `result.json`.

## Single-query elapsed time

Thirty queries: ten per language condition, using the same retained questions and candidates. All bulk evaluation traffic finished before these measurements. Local scoring includes tokenization and actual inference with the model loaded. GPU timing includes the public network route, normal client-key admission and reading the response. The 64-candidate route sends 50 + 14 in parallel, as the product does. First network connection setup is included; model download/load is not. These are reranking-step times, not full memory recall or GPU card-seconds.

| Client / operation | Queries | Median | Maximum |
|---|---:|---:|---:|
| Linux EPYC: Horizon local, 15 | 30 | 585.8 ms | 690.3 ms |
| Linux EPYC: public GPU, 15 | 30 | 127.2 ms | 221.3 ms |
| Linux EPYC: public GPU, 64 | 30 | 354.2 ms | 403.6 ms |
| Apple M4 test Mac: public GPU, 15 | 30 | 266.3 ms | 875.1 ms |
| Apple M4 test Mac: public GPU, 64 | 30 | 503.1 ms | 784.8 ms |

The Linux client shares the GPU service’s host; its public-route network position is not representative of every customer. The separate M4 test Mac had no existing local-model runtime; none was installed. Its network figure must not be compared to the EPYC local figure as if both came from one machine. Thirty observations establish this run’s median, not a production tail-latency guarantee.

## Existing scoring issue observed; no product change

The current source blends `0.7 * sigmoid(raw GPU logit)` with `0.3 * max(vector, keyword)`. Applying that exact formula to the real GPU responses loses much of the model’s ranking benefit. Raw positive logits crowd near one after sigmoid, allowing the source score to dominate their smaller remaining differences. The table labels this as a formula replay, not an end-to-end production recall score. The observed issue belongs to `packages/memory/src/engine/retrieval/retriever-rerank.ts` around `crossScore` / `blendedScore`, with weights in `packages/memory/config/index.ts`. It should be addressed before using the current blended order to judge whether GPU inference is worthwhile. This assessment does not change it.

## Boundaries and evidence

- This evaluates retrieval ranking against the original evidence-turn labels, not the final assistant answer. Corpus creation, extraction quality, later importance/recency stages, final filtering and token-budget pruning are not rerun. Retained candidate pools and their original embeddings come from the existing study; this is a controlled reranker comparison, not a claim that the entire current retrieval system has been benchmarked end to end.
- Chinese text is the existing translated LoCoMo variant. Only ten source conversations are represented; answerable questions are included, not the adversarial/unanswerable category. Conclusions do not establish performance on all production memory distributions, long-memory tasks, cold starts or every laptop.
- Quality calls use the original service-evaluation authorization through the public endpoint. Latency uses the normal configured client key. Initial ordinary-key bulk traffic encountered 25 rate-limit refusals; one later request had a TLS EOF. Only missing attempts were repeated, and all questions are complete. Failures remain recorded in raw evidence rather than being silently relabelled successful.
- A mistakenly overlapping 42-row Mac timing attempt was stopped and excluded. Final Mac and Linux timings were collected separately after bulk scoring ended.
- The original metric was checked against known correct, wrong-first, and correct-within-five orders. No empty run, full unit/integration suite or LLM answer-generation evaluation was used as proof.
- Machine settings, hooks, production code and memory stores were unchanged. No commit, push or release was performed.

Machine-readable receipt: [result.json](result.json). Raw transport responses, model scores, original evaluation scripts and timing records: the `raw_artifact_directory` field in the receipt. Raw datasets and runs are intentionally kept out of this directory.
