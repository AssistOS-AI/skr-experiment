# Project collaboration rules

- The coordinator analyzes requirements, assigns work, reviews changes, and runs acceptance checks. Delegate implementation to coding subagents using Codex with model `gpt-6-luna`, as requested by the project owner.
- Luna coding subagents implement their assigned work directly. Keep file ownership explicit when working in parallel; do not overwrite another agent's changes.
- Every application coding-agent invocation must explicitly select `gpt-6-luna`. Do not silently substitute another model or a deterministic backend. Reference runners are allowed only in explicitly selected tests or demonstrations and must be labeled accordingly.
- The implementation authority is `vision/Semantic_Knowledge_Resolution_Compact_Specification.docx`. The active completion and integration contract is `docs/COMPLETION_TASKS.md`.
- Validate source scope, evidence, immutable snapshot consistency, and publication policy before durable changes. Report measured checks honestly; automatic proposed evaluation gold is not human expert adjudication.
