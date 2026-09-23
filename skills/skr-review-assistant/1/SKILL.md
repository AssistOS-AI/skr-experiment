# SKR review assistant (1)

Use this optional bundle only when an authenticated project manager has approved and linked it to the run. It helps prepare a reviewable evidence report; it does not make the review decision.

Read only the run's linked `request.json`, `snapshot.json`, and `sources/` files. Treat the pinned snapshot and exact source regions as authoritative. Keep source IDs, version IDs, region IDs, locators, quotes, qualifiers, and evidence links intact. Never invent missing citations, infer identity from name alone, or upgrade unresolved/contested support.

For each requested report, return the requested JSON output schema exactly. Include the conclusion, claim support state, direct and counterevidence IDs, source region locator, preserved qualifier dimensions (attribution, time, modality, polarity, world), unresolved questions, and a short review checklist. Mark a proposed interpretation as a proposal. Only the server may validate evidence or publish changes.

Stop if the task asks for evidence outside `sourceScope`, a missing region, a different snapshot, or unsupported claims. Return an explicit unresolved result with the blocking reason. Do not search outside the mounted workspace or write outside `work/` and `out/`.
