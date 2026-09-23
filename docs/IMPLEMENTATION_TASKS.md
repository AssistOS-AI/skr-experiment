# Original SKR implementation task plan (historical)

Authority: `vision/Semantic_Knowledge_Resolution_Compact_Specification.docx`, September 2026. Coordinator reads, assigns and reviews; implementation belongs to Luna subagents.

This original prototype plan is retained for traceability. It is superseded by [COMPLETION_TASKS.md](COMPLETION_TASKS.md), which requires the full software implementation, real six-baseline adapters, complete-book ingestion, authentication and OS isolation. All three coding owners use `gpt-6-luna`. Current coordinator evidence is in [ACCEPTANCE_MATRIX.md](ACCEPTANCE_MATRIX.md); the final outcome belongs in [FINAL_REVIEW.md](FINAL_REVIEW.md). Statements below about unavailable backends or prototype-only scope describe the original plan, not the current delivery.

## Delivery strategy

Implement a runnable local Node.js 24 ESM application with built-in modules and `node:test`, no required npm dependencies. File-backed immutable snapshots and content-addressed originals are the initial object/project store. Use HTTP JSON APIs and a local static chat UI. User clarification: actual coding-agent runs must always launch Codex with Luna, with an enforced model argument and no fallback to another model/backend. The deterministic reference runner is only an explicit test/demo mode and cannot claim model execution. Evaluation adapters must distinguish executable reference baselines from unavailable real embedding/GraphRAG/model backends. Never invent benchmark results or treat fixture counts as the full research release.

## Shared contracts (coordinate changes before editing another owner's files)

- `src/store.mjs`: export `ProjectStore`, constructor `{rootDir}`. All methods may be awaited. `createProject(name)`, `listProjects()`, `getProject(id)`, `getSnapshot(projectId, snapshotId?)`, `forkProject(parentId, snapshotId, name)`, `getAncestry(projectId)`, `diffProject(projectId)`, `rebaseProject(projectId,newParentSnapshotId)`, `exportProject(projectId,snapshotId?)`, `commit(projectId,expectedSnapshotId,changeSet)`, `registerSource(projectId,{name,content,mimeType?,sourceId?})`, `readSource(sourceVersionId)`, `saveRun(run)`, `getRun(id)`, `listRuns(projectId)`.
- Snapshot effective view: `{id,projectId,parentSnapshotId,sources:[],procedures:[],records:[],policy:{}, ...versionMetadata}`. Sources: `{id,sourceId,name,digest,mimeType,regions:[{id,text,locator}], ...}`. IDs opaque, filesystem safe. `readSource(id)` returns original Buffer; regions can be part of version metadata. Registration creates a snapshot; updates preserve original versions.
- ChangeSet: `{sources?:[],records?:[],procedures?:[],policy?:{},coverage?:[],overrides?:{}}`. Records keyed by `id`, procedures by `id` + `version`; effective procedures select newest explicit local override. Concurrency failure must reject before any durable project mutation. Derived records use `dependencies: string[]`, `sourceSnapshotId`, `procedureId`, `procedureVersion`, `lifecycle`.
- `src/engine/index.mjs`: `parseSKE(text)`, `printSKE(ast)`, `match(goal,records,options?)`, `reason(records,rules,options?)`, `resolve({question,goal?,snapshot,sourceScope?,procedures?,policy?})`, `ingestSource(source,{snapshot, ...options}?)`, `applyProcedure({procedure,snapshot,parameters?,sourceScope?})`, `auditEvidence({answerPackage,evidence,snapshot,sourceScope?})`. API outputs may be sync/async; call with await. Engine owner documents exact AST/match formats early.
- Agent output bundle: `{answerPackage,evidence,coverage,changeSet?,validation}`. AnswerPackage includes answer, claims with evidence IDs, interpretation, supportState, coverage, procedure versions, snapshotId, residuals. Never claim semantic support solely from string proximity. Source evidence includes sourceVersionId, regionId, quote; derived evidence includes premise IDs and transformation.
- `src/server.mjs`: export `createApp({dataDir,runner?,...options})` returning HTTP server/app and store; document actual return contract. CLI `npm start`, `npm test`, `npm run demo`, `npm run eval`. Third agent owns package.json and integration glue.
- Requests: QUESTION, INGEST_SOURCE, APPLY_PROCEDURE, BUILD_PROCEDURE, AUDIT_PROJECT, EVALUATE; validate project/source authorization before exposing views. One workspace and recorded runner session per logical request; all selected sources pinned. Private local filesystem scope, no arbitrary filesystem path reads from HTTP input. Bind loopback by default.
- Tests use temp directories; do not edit source DOCX or commit git changes. Keep all implementation and documentation in repository; generated data/results ignored.

## LUNA-A: projects, sources and snapshots

Owner: `src/store.mjs`, `src/source-readers.mjs`, `tests/store.test.mjs`, `tests/source-readers.test.mjs`, `docs/STORAGE.md`.

Implement persistent immutable snapshots; source content digests and stable region locators (plain text, JSON/CSV, PDF via optional local `pdftotext`, DOCX via available extractor where practical); copy-on-write fork; exact parent pinning; child isolation; ancestry/diff/export; explicit rebase with override/dependency checks; versioned procedure/policy records; optimistic atomic commit; source/procedure invalidation with transitive dependency propagation; run persistence. Coverage must explicitly retain unreadable/deferred regions rather than fabricate semantic extraction. Preserve original source bytes. Validate all IDs and store boundaries.

Acceptance: restart persistence, parent update does not alter children, sibling isolation, source versions reopen, conflict leaves head unchanged, rebase and procedure/source changes stale appropriate dependent records. Explain unsupported formats honestly.

## LUNA-B: semantic engine, procedures and evaluation

Owner: `src/engine/**`, `src/evaluation/**`, `fixtures/**`, `tests/engine*.test.mjs`, `tests/evaluation*.test.mjs`, `docs/ENGINE.md`, `docs/EVALUATION.md`.

Implement recursive predicate-first parser (nested terms, literals, variables, variadic predicates), safe exact unification, shared joins, range-restricted rules and bounded fixpoint/multihop resolution with premise provenance. Preserve time/modality/attribution scope, no role reversal or unjustified weaker-to-stronger matches. Residuals and counterevidence. Ingestion ledger plus conservative extraction; three versioned procedures: contradiction audit, relevance synthesis, document/literary rubric. Findings carry exact procedure, parameters, evidence and dependencies. Evidence audit reopens region quotes and validates derived chains; do not pretend deterministic heuristic judgments are LLM/expert judgments.

Implement frozen controlled fixtures spanning specification families, an executable evaluation CLI, metrics by family and cost accounting with measured wall time and explicit missing model cost. Gold stays outside runner payload. Include adapter contracts/status for all six required baselines; honest unavailable status for missing genuine backends. Do not label lexical retrieval as full hybrid RAG/GraphRAG. Add meaningful tests of joins, recursive query, multihop evidence, absence, role reversal, modality, time, stale evidence, procedures and evaluation leakage.

Acceptance: direct/join/multihop and incomplete fixtures pass; every strict factual claim has reopenable support; derived evidence checks all premises; real benchmark release remains explicitly pending until corpora/backends/expert annotation exist.

## LUNA-C: runtime, API, UI and integration

Owner: `src/server.mjs`, `src/runtime/**`, `public/**`, `skills/**`, `scripts/**`, `tests/runtime*.test.mjs`, `tests/server*.test.mjs`, `package.json`, `.gitignore`, `README.md`, `docs/RUNTIME.md`.

Implement server API including project/fork/rebase/source operations, asynchronous submit/observe/cancel/explain run, task routing for all six types, run workspaces with snapshot/request/policy and authorized source/KB/procedure views, approved versioned skill symlinks, checkpoints/events, default Codex subprocess adapter pinned to `gpt-6-luna` and explicit deterministic test/demo mode. Validate schemas, scope/evidence, stale dependencies, policy and expected snapshot before publish/commit; cancelled/failed runs cannot commit. Avoid arbitrary command construction; task text is data. Document filesystem permission limits honestly (read-only views are not a sandbox for same-UID processes).

Build a working local project/book-chat UI: create/select/fork projects, ancestry/local delta, source upload and scope, inherited procedure selection/application, chat, run progress and cancellation, evidence inspector. Implement all core skill contracts from spec as useful versioned SKILL.md files. Use engine/store API; coordinate interface gaps directly with owners. Demo seeds base procedure project and independent book fork(s), sources and factual/join questions. README with exact startup/demo/test/eval instructions and capabilities/limitations.

Acceptance: HTTP integration tests cover create/fork/ingest/question/evidence, scope isolation, publication rejection, concurrency/cancel, and honest external adapter status. No published unsupported claims. Run complete test suite and demo; report gaps to coordinator.

## Coordinator final review

Review implementation against sections 8.1–8.6; run independent tests and demo/evaluation; inspect snapshot isolation, scope handling, evidence integrity, cancellation and actual baseline status. Send defects back to Luna owners. Record completed capabilities and remaining research/product gaps without representing milestones as finished if acceptance is unmet.
