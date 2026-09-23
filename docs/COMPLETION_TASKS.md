# SKR completion work — reopened 23 September 2026

User rejected stopping at the prototype. Implement the remaining software and exercise it end-to-end now. Parent coordinates/reviews only; all coding by the three Luna owners. No automatic fallback from Codex `gpt-6-luna`. Do not use missing expert annotations as an excuse not to implement/run the rest. Do not invent expert judgments or label tests a research result.

## Integration contract

Runtime owner provides `CodexLunaSession` in `src/runtime/session.mjs`: constructor `{workspaceDir,timeoutMs?,onEvent?,isolation?}`, `request({prompt,schema,signal})` -> `{output,sessionId,usage,wallMs}`. JSONL session ID/usage recorded; requests resume same Codex session, persist checkpoint across restart, always Luna. Generic schema results are raw parsed JSON, not answer-bundle normalization. Client executable is fixed by application, test injection allowed only server-side. Owners coordinate exact details directly.

All model-based ingestion, semantic review, question interpretation, procedures and evaluation use this runtime/session API. Ingestion can issue sequential session turns but remains one logical run with its pinned snapshot, ledger/checkpoint and staged transaction. No independent arbitrary-model API implementations.

Ingestion owner provides `src/ingestion/index.mjs`: `ingestProject({snapshot,sourceScope,session,checkpointDir,signal,onEvent,procedures})`, `materializeProcedures({...})`, `reviewAssertions({...})`; return existing normalized answer/evidence/coverage/changeSet bundle where practical. Every region is accounted for. Semantic source interpretations carry source/quote/qualifiers and separate review records; review can be model-assisted (labeled), never silently declared human approved. Deterministic source checks and scope audit stay mandatory. Session mocks support offline tests, real smoke uses Luna.

Index owner provides `src/query/index.mjs`: snapshot-keyed persisted structural predicate/entity/arg indexes and lexical BM25 index; search/query tools plus scope-safe source navigation. Evaluation owner may consume these but owns its own retrieval baselines.

## LUNA-A (storage owner): whole-source ingestion and knowledge services

Own `src/store.mjs`, `src/source-readers.mjs`, `src/ingestion/**`, `src/query/**`, `src/runtime/change-validation.mjs`, corresponding tests, `docs/INGESTION.md`, `docs/STORAGE.md`, `docs/QUERY.md`.

Implement whole-source chunking preserving regions, resumable coverage, actual Luna extraction and source-grounded semantic verification, entity aliases/reversible reconciliation, cross-chapter context pass, explicit contradictions/qualifiers. Add PDF page/image/OCR reader using installed pdftoppm+tesseract with time/resource bounds and text+scan tests; EPUB or explain source format negotiation. Materialize all three versioned procedures using real reviewable evidence and parameters, invalidate/recompute stale findings and promote accepted ingestion through validated transactions. Add structural and lexical indexes, snapshot-safe persistence. Strengthen store for multiple writer processes (filesystem lock/CAS) with crash-safe behavior. Do not edit server/runtime runner files; coordinate exports.

Acceptance: actual prose-source ingestion -> approved/model-reviewed structured records -> NL question answer with reopened evidence; whole-region coverage including unreadable; alias reversal; procedure update -> stale -> recomputation; index scope isolation; restart/checkpoint continuation. Agent semantic review is recorded as model review, never human approval.

## LUNA-B (engine owner): real baselines and reproducible research tooling

Own `src/engine/**`, `src/evaluation/**`, `fixtures/**`, `corpora/**`, `scripts/evaluate.mjs`, `scripts/build-evaluation*.mjs`, `scripts/fetch-corpora*.mjs`, baseline install/bootstrap scripts, corresponding tests and `docs/EVALUATION.md`.

Implement all six executable baselines: Hybrid RAG with actual local semantic embeddings + lexical retrieval + reranking (download/install public embedding model when needed), agentic source retrieval using Codex Luna session, graph/community retrieval with documented graph extraction/community construction/summaries, full-source agent, SKR Direct, SKR Full. Same pinned answer model for live comparisons, explicit budgets; no heuristic bag-of-words pretending to be neural embeddings or baseline names with unavailable bodies. Runtime session API shared above. Add semantic goal interpretation/reasoning integration where engine needs it, keeping evidence audited and qualifiers preserved.

Build 300–500 controlled cases (real distinct generators across specified families), 50–100 procedure cases, 50–100 source/procedure/fork mutation cases with ground truth. Acquire at least five complete public-domain short books, immutable checksums/provenance, construct 100–200 book questions + source locations and expert-adjudication workflow. Automatic proposed gold stays labeled; do not fabricate expert review. Implement independent case freeze vs run, gold isolation, paired comparison/bootstrap confidence intervals, all quality/evidence/coverage/binding/update metrics, token/tool/latency/preprocessing/query costs and amortization. Support equal-budget and quality-first regimes.

Run full offline controlled/update/procedure suites and a live small paired comparison exercising all six actual baselines plus complete-book ingestion integration. Record measured results. Avoid launching thousands of paid model calls blindly; corpus and full-run commands must be ready, small live smoke must be real and reproducible. External expert adjudication is the only genuinely user/human-dependent acceptance, not missing implementation.

## LUNA-C (runtime owner): persistent agent sessions, integration, UI, auth/isolation

Own `src/runtime/**` except change-validation, `src/server.mjs`, `src/auth/**`, `src/security/**`, `public/**`, `skills/**`, `scripts/demo.mjs`, `scripts/serve*.mjs`, `scripts/runtime*.mjs`, package manifests, README, deployment container files, runtime/server/UI tests and docs.

Implement shared CodexLunaSession first and notify other owners; verify installed CLI `exec resume --help` actual behavior. Record thread ID, token usage/cost inputs, checkpoints, restart/recovery and resume APIs preserving pinned snapshot, agenda/bindings/residuals and one logical transaction. Add approved versioned skill registry with request/approve/link flow and capability checks. Integrate real ingestion/review/materialization/query services and EVALUATE/BUILD_PROCEDURE/AUDIT_PROJECT; no task left as an unavailable handler. Full UI exposes procedure versions, source coverage, conversations/history, resume, approval/review, refreshed findings, report/export and evidence source region inspection.

Implement authentication + project-level authorization and safe bootstrap/token/session management without exposing credentials in logs; preserve explicit trusted local development mode. Add OS filesystem isolation profile using installed bwrap or container (only workspace and approved readonly mounts; Codex runtime/auth needs narrowly mounted). Verify unauthorized host sentinel cannot be read in secure mode; fail closed if isolation unavailable, document usable setup. No actual public deployment required. Multiuser source/run/evidence access must be tested across distinct identities. Cost pricing configurable/dated; tokens measured, unknown dollars explicit.

Live tests: actual Luna session creation+resume, prose ingestion -> question -> materialized analysis, all task types and restart; no model substitution. Package scripts expose complete workflows. Coordinate baseline dependency changes directly with LUNA-B.

## Coordinator acceptance

Root reviews implementation and runs acceptance, delegates fixes. Finish software work, not merely write a new backlog. Final review must accurately distinguish implemented/tested behaviors, executed small live experiment, full-run reproducible tooling and the genuinely external human expert signoff. Preserve original DOCX and previous changes; do not git commit.
