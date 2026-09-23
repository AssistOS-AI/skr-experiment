# Evaluation workflows

Reports distinguish deterministic structural checks from live GPT-6-Luna runs. Automatic book answers and their independent Luna evidence checks are still proposed labels, not expert adjudication. Never treat a smoke run as a ranking study. Gold is kept out of answering payloads; a requested judge runs after answering in separate baseline sessions.

## Fixtures and offline checks

The controlled fixture contains 346 generated structural cases across scope, joins, opposition, revisions, and adversarial families. It tests SKE reasoning and evidence contracts, not natural-language answer quality. The procedural contract fixture contains 60 exact-version structural checks. The mutation fixture exercises update invalidation, procedure activation, forks, and rebases through the store. Each frozen fixture has a sibling `.lock.json` with a SHA-256 digest; evaluation rejects a changed fixture until it is deliberately re-frozen.

```sh
npm test
npm run eval:controlled
npm run eval:procedures
npm run eval:mutations
npm run eval:books -- --fixture=fixtures/book-questions-v1.json
```

The five-book corpus manifest pins downloaded bytes by checksum and records source URLs and complete-work boundary handling. `fixtures/public-books-v1.json` is a separate 100-item exact-locator smoke set; it is not the semantic book QA set. `fixtures/book-questions-v1.json` is built with an initial Luna proposal and a separate Luna sufficiency review per book. Its gold remains `pending-human-review`. Builder checkpoints are per book, so generation can resume without repeating completed books:

Reproducible source snapshots use the persistent `scripts/build-book-snapshot.mjs` CLI. It verifies each selected manifest checksum before registering the complete source, seeds the canonical procedure versions, and atomically writes a sanitized snapshot export. For example, `node scripts/build-book-snapshot.mjs --books=pg14838 --out=artifacts/research/peter-rabbit.json --store-dir=artifacts/research/peter-rabbit-store` prepares the project without model calls. Add `--ingest` to run actual Codex Luna ingestion; the stable store, checkpoint directory, and `/tmp` session workspace support restart. Ingestion changes are validated with the pinned source scope and review receipts before a store commit. The export records Luna session ID, request count, cumulative usage, coverage, and receipt count. A failed run writes a private recovery marker beside its checkpoint; do not put session workspaces or authentication material under `artifacts/`.

```sh
node scripts/build-evaluation-questions.mjs fixtures/book-questions-v1.json --checkpoint-dir=/path/to/private-checkpoints
node scripts/freeze-evaluation-fixture.mjs fixtures/book-questions-v1.json --freeze-proposed
```

The `--freeze-proposed` flag freezes the current proposal bytes; it does not signify expert approval. To create a human-review CSV, run `node scripts/adjudicate-book-questions.mjs export fixtures/book-questions-v1.json review.csv`. Import decisions with the corresponding `import` command; accepted/revised expert answers are kept distinct from original proposals, rejected items are excluded from expert-scored results, and unresolved rows remain pending. Never replace a proposed answer with a fabricated adjudication.

The 60-book procedure-task fixture crosses the five complete works, three pinned procedure definitions, and four substantive parameter profiles. It specifies source evidence obligations and leaves proposed findings/scores and human decisions unfilled until run/review. The smaller 60-case `fixtures/procedures-v1.json` remains the deterministic structural contract suite. Procedure versions are immutable; changing a contract requires a new version and a new fixture freeze.

## Six baseline comparison

The executable baseline IDs are `hybrid-rag`, `agentic-rag`, `graphrag`, `full-source-agent`, `skr-direct`, and `skr-full`. Retrieval methods use their own indexes or source navigation; every live answer uses the shared Codex `gpt-6-luna` runtime. Hybrid retrieval combines local neural embeddings, BM25, and a cross-encoder reranker. GraphRAG builds and caches a source-only graph/community index in a separate preprocessing session before the fresh answer session. Preprocessing is measured separately and amortized by the declared query count. Full-source mounts the complete authorized work and reports the measured input/context footprint. SKR Direct disables inference rules; SKR Full uses goal-directed scoped semantic resolution and audited evidence.

For reproducible live work, provide either a sanitized snapshot export or a project-store root and snapshot ID. The case fixture must be frozen unless `--allow-unfrozen` is explicitly passed. A deliberately small Peter Rabbit paired smoke is:

```sh
node scripts/run-live-comparison.mjs \
  --snapshot-json=fixtures/research/peter-rabbit-ingested-snapshot.json \
  --questions=fixtures/research/peter-rabbit-count-names-smoke-v1.json \
  --limit=1 --judge --mode=quality-first \
  --output=artifacts/research/peter-rabbit-quality-first.json
```

An equal-budget run uses the same snapshot and frozen fixture, with `--mode=equal-budget`; budget breaches make a row ineligible rather than silently relaxing the cap. The graph index is cached by source bytes, model/profile, and extraction limits; its source-only preprocessing costs remain visible on cache hits and are amortized separately from per-query costs. `--start`, `--limit`, `--checkpoint-dir`, `--baselines`, and `--amortization-queries` support deliberate resumable batches. Defaults select one case to avoid surprise model calls. Never use the baseline's conversation with gold; the separate judge gets gold only after all answer calls complete.

Reports include answer/residual judgments when requested, source-region evidence precision/recall, audit status, unresolved/error counts, per-turn model usage, prompt characters, tool calls, latency, preprocessing cost, query cost, amortization, and budget eligibility. Model-judged results remain explicitly pending human review. Dollar costs are null unless a dated pricing schedule is configured. A single-question report is only a reproducibility smoke, not evidence that one baseline is generally better.

## Bootstrap and limits

Before the first neural retrieval run, `@huggingface/transformers` downloads the pinned local embedding and reranking models. Model identities/revisions are included in cache fingerprints; cached vectors are not ground truth. An offline controlled run does not download models or make live model calls. Controlled fixture metrics measure structural answer/binding/evidence behavior; retrieval evidence metrics compare common source regions/spans; store mutation metrics measure lifecycle and authorization. Missing human labels yield unavailable expert accuracy, not a zero score or an inferred judgment.
