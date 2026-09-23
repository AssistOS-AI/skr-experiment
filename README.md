# Semantic Knowledge Resolution (SKR)

SKR is a local, project-oriented knowledge system. It keeps immutable project snapshots, versioned source files, reviewed assertions, exact procedure versions, source evidence, and copy-on-write forks. Every run pins its snapshot and source scope; proposed changes are validated and either staged or committed under the project policy.

## Run locally

Use Node.js 24 or newer, install the package dependencies with `npm install`, and ensure Codex CLI is installed and authenticated as the local user. Secure mode also requires `bwrap` with user namespaces enabled; the server fails closed when isolation cannot be established.

```sh
npm start
```

Open <http://127.0.0.1:3000>. On first launch, the single-use bootstrap token is written to `data/auth/bootstrap.token` with owner-only permissions. Enter it under “First-time setup” to create the first account. Later users are created by an authenticated project manager through the user API. The service binds to loopback by default; it is not a public deployment configuration.

Production coding-agent calls always use `codex exec --model gpt-6-luna`. The model/backend is fixed by the application, never selected from user request data. No alternate model or backend fallback is used. `/api/status` reports the configured model separately from each run's actual execution and measured usage; deterministic audits or offline evaluations with no model calls do not claim model execution.

To explicitly use local-only development authentication, start with `SKR_TRUSTED_LOCAL=1 npm start`. This bypasses login and is intended only for a trusted local development environment. To run the deterministic reference demo, use `SKR_RUNNER=reference npm run demo`; reference output is labeled as such and never described as an actual coding-agent run.

## Workflows and checks

```sh
npm test
npm run demo
npm run eval:controlled
npm run eval:mutations
npm run eval:procedures
npm run eval:books
npm run eval:live -- --snapshot-root=/path/to/project-store --snapshot=snap_ID --source-version=srcv_ID --question='Ask one question'
```

The UI supports account bootstrap/login/logout, project creation, source upload and replacement, source-region navigation, forks, rebasing, scoped questions, resumable runs, evidence inspection, project/report export, and validated publication. New projects include `contradiction-audit`, `relevance-synthesis`, and `document-literary-rubric`; the literary rubric includes narrative coherence, characterization, style, and thematic development criteria with counterevidence requirements. A procedure draft remains inactive until an authenticated manager approves that exact immutable version. Questions default to no analysis method; an exact version and parameters can be selected explicitly. Source or procedure changes stale dependent materializations. Procedure authors can opt into `on-ingestion` to run an exact, manager-approved method as part of source upload; other materialization remains explicit, with no background scheduling.

Shipped task skills are ready by default. Optional skill versions are requested and manager-approved before being linked to a run. The Codex workspace receives only the pinned source scope, request, snapshot, and exact approved skill versions. Session IDs and measured per-turn token usage persist across restart; resumable runs keep the original snapshot and workspace.

`eval:controlled` runs the frozen structured fixture suite. `eval:mutations` runs 60 store-backed source-update, procedure-activation, fork-isolation, and rebase cases with varied dependency depth, unaffected findings, nested forks, stale writers, and recomputation. `eval:procedures` runs the local procedure fixture suite. `eval:books` runs the public-domain book location/retrieval smoke. `eval:freeze` records a fixture hash and discloses its gold status; `eval:live` performs an explicit paired Luna comparison and requires a pinned project store/snapshot/scope. Book-question construction and adjudication commands are documented in [docs/EVALUATION.md](docs/EVALUATION.md). Evaluation reports separate deterministic persistence checks from actual model calls and keep proposed book answers pending human adjudication.

See [docs/RUNTIME.md](docs/RUNTIME.md), [docs/STORAGE.md](docs/STORAGE.md), [docs/ENGINE.md](docs/ENGINE.md), and [docs/EVALUATION.md](docs/EVALUATION.md) for runtime, storage, semantic, and evaluation contracts.

## Research limits

A successful source-region read or model-assisted review is not expert adjudication. Automatic public-book answers remain proposals until human reviewers decide them. Evaluation metrics with no adjudicated gold remain null. Model costs in dollars remain unknown unless a dated price schedule is configured; token and wall-time usage are recorded when an actual session runs. The controlled and mutation suites verify software behavior, not research effectiveness.
