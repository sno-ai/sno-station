# Optimized local and Sno GPU reranking — 2026-10-21

Both fixed models received the same candidate pools and parameter-search opportunities. Final scoring uses literal actual-cap inference and the real product scoring pipeline; the original study measured a proposal. Its subsequent source implementation is recorded below. The previous unoptimized backend-selection conclusion is withdrawn.

**Exact local model:** `Horizon-Labs/multilingual-reranker-small`, deployed as `sno-lab/multilingual-reranker-small-int8` at the pinned revision in the receipt. **GPU:** `ettin-reranker-400m-v1`. Quality was measured on the Linux AMD EPYC 7F52 evaluation host; both latency routes were measured on the same Apple M4 client.

## Quality after optimization

R@5 is the original evaluation's share of questions with at least one gold evidence memory among the first five results. The three LoCoMo rows each use the same 750 held-out source questions in their respective language condition. They are translations, not independent datasets. LongMemEval uses its existing answer-session labels.

| Dataset | Horizon 15 | GPU 15 | Horizon 40 | GPU 64 |
|---|---:|---:|---:|---:|
| English query / English memory | 73.73% | 76.13% | 76.13% | 80.53% |
| Chinese query / Chinese memory | 60.80% | 60.67% | 61.87% | 61.33% |
| Chinese query / English memory | 66.27% | 69.20% | 70.00% | 77.07% |
| LongMemEval-S (20 questions) | 100.00% | 100.00% | 100.00% | 100.00% |

First-result evidence hit rate (original R@1):

| Dataset | Horizon 15 | GPU 15 | Horizon 40 | GPU 64 |
|---|---:|---:|---:|---:|
| English query / English memory | 52.00% | 60.80% | 54.27% | 63.33% |
| Chinese query / Chinese memory | 46.00% | 47.73% | 47.33% | 47.73% |
| Chinese query / English memory | 46.00% | 51.20% | 48.80% | 54.93% |
| LongMemEval-S (20 questions) | 95.00% | 95.00% | 95.00% | 95.00% |

Full original R@3/R@10, reciprocal rank, discounted gain, per-conversation results and paired hit counts are in `result.json`. No new questions, evidence labels, LLM judge, or replacement evaluation metric were authored.

## Same-client latency

Thirty matched short-memory queries: ten per language condition. Bulk evaluation finished first. The CPU model was loaded and used four threads, selected on separate calibration queries. GPU timing uses the normal client credential and public route, including response reading; the native 64-candidate transport sends 50 + 14 concurrently. These are the reranking model/network steps, not full recall elapsed time or GPU card-seconds.

| Profile on Apple M4 | Candidate count | Median | Maximum |
|---|---:|---:|---:|
| Horizon local | 15 | 167.8 ms | 242.1 ms |
| Sno GPU | 15 | 278.8 ms | 1742.7 ms |
| Horizon local | 40 | 360.7 ms | 455.2 ms |
| Sno GPU | 64 | 541.9 ms | 878.3 ms |

## What was wrong

- The original fill-text script restored real retrieved candidates, but filled their missing fusion/vector/keyword scores with zero. It did not inject gold answers. English and Chinese blend replay values therefore do not reproduce complete product inputs. The cross-language pool has no such filled entries. Invalid source values were excluded from fitting; texts and complete cosine values were retained identically for both models.
- GPU logits crowd near one after sigmoid. Mixing those tiny differences with `max(vector, keyword)` lets the source score overturn meaningful model preferences. This was reproduced with actual current-product GPU calls on fully observed training examples.
- Removing the source blend alone is insufficient: sigmoid still flattens relevance before the final diversity step. An actual product example moved gold evidence from raw model rank 2 to final rank 44 with pure sigmoid; normalizing the raw logit range and running the same product diversity function kept it at rank 2. This is a mechanism reproduction, not a claim that this single normalization is universally best.
- The local path also reaches the shared diversity stage, which can change its model order. Q8 scores additionally depend on length-sorted batch composition. Restricting a full64 score cache is not an actual 15-candidate run. Every final profile was therefore scored literally, with its chosen head and original tail, before calling the actual product scoring pipeline.

The cross-language reference below uses the same 750 held-out questions and complete branch scores. Model outputs were retained from actual prior product inference; the current post-scoring function was replayed with actual recomputed embeddings. It is a fixed-pool reference, not a production traffic measurement.

| Current default reference | Before final diversity | After current product scoring |
|---|---:|---:|
| Local 15 | 66.67% | 64.53% |
| GPU 64 | 56.13% | 40.40% |

## Concrete proposed changes

Use the complete semantic cosine score for the shared initial ordering, rather than tuning on fabricated source zeros. Normalize model relevance before mixing it with that score; preserve the selected local score-slot behavior where measured. Set the existing diversity strength for the chosen profile. No backend switch is justified by the old blend table.

| Profile | Scored head | Model transform | Model / cosine weights | Score assignment | Existing MMR lambda |
|---|---:|---|---|---|---:|
| local_15 | 15 | minmax | 0.3 / 0.7 | score_value | 0.8 |
| gpu_15 | 15 | minmax | 0.5 / 0.5 | score_value | 1.0 |
| local_best | 40 | minmax | 0.5 / 0.5 | rank_slots | 0.9 |
| gpu_best | 64 | rank | 0.9 / 0.1 | score_value | 0.9 |

`rank_slots` assigns the initial descending scores to the judged candidates in their learned blend order and retains the tail; `score_value` uses the normalized blend itself and the existing 0.8 source penalty for unjudged tail candidates. `rank` scales the model order from 1 to 0; `minmax` scales its raw logit range from 0 to 1. These are relative ranking values, not calibrated correctness probabilities.

Implementation belongs in `packages/memory/src/engine/retrieval/retriever-rerank.ts` (initial ordering, model-score blend, local head size), `packages/memory/src/engine/retrieval/retriever-scoring-pipeline.ts` (existing final diversity behavior), and the existing retrieval defaults/configuration. Reuse the current model-order/score-slot handling; do not add a second ranking framework. The quality-oriented local profile scores 40 candidates; retaining 15 is a separate measured speed/quality choice. No product source or settings were changed in this study.

## Reproducibility and limits

The original `depth/evaluate.py` supplies all reported metrics unchanged. Each model searched 3,168 equal configurations: eight candidate caps, three model transforms, eleven blend weights, two score-assignment policies and six diversity strengths. Fitting used five conversations (786 questions per language condition); all four final configurations were frozen before literal validation on the other five conversations (750 per language). The retained 20 LongMemEval-S questions were not used for fitting. True embeddings were recomputed with the current local embedder; current default importance, threshold and disabled temporal/length stages were included in the product scoring replay.

This is optimization within a finite declared search, followed by literal final validation. Cached full64 logits guide selection and can differ from actual-cap q8 outputs; no global-optimum claim is made. The candidate pools themselves are the original study's fixed retrieved pools, not a rebuilt production retrieval database. Evidence-hit quality is not final assistant-answer accuracy. The evaluation does not establish performance on unanswerable queries, custom positive score thresholds, all coding-memory distributions, cold starts, or long-memory Mac latency.

The old English/Chinese blend percentages must not be reused as production quality numbers. Raw datasets, responses, inference outputs, exact scripts and detailed debugging traces remain under the receipt's `raw_artifact_directory`; only this report and the formal aggregate receipt are in `evals/`. No commit, push, deployment, settings, hooks or memory-store change was made.

Machine-readable receipt: [result.json](result.json).

## Source implementation — 2026-10-22

The source now implements the local 40-candidate profile and the GPU 64-candidate profile: shared cosine ordering, local minmax with equal model/cosine weights and score slots, GPU rank normalization with 0.9/0.1 weights, and default MMR lambda 0.9. Existing explicit operator overrides remain in force. The selected backend is unchanged. No running service was restarted or package released.

A focused transport regression exposed an additional error in the proposed rank transform: equal low logits received different scores according to ID order, and those at the top of the tie could overtake the unique model winner after blending. Equal logits now share their average rank. The previously failing saturated-logit case passes against the real GPU service; the first-40 local cap, model ordering and deadline checks also pass. Two existing log assertions required enabling info logs in their test setup; product logging behavior was not changed.

The original evaluation and actual GPU64 inference were reused on the same Linux AMD EPYC 7F52 host, with retained real embeddings and the product scoring pipeline. This is a replay of the changed scoring, not new model inference or new latency measurements. All 2,250 LoCoMo observations and 20 LongMemEval observations were retained. The original experiment tables above remain historical. Updated GPU64 R@5 is 80.53% English/English, 61.33% Chinese/Chinese, 77.20% Chinese/English, and 100% on the 20 LongMemEval questions. Local40 retains the study's unchanged scoring profile. Full updated metrics and validation scope are under `implementation_update_2026_10_22` in the receipt.
