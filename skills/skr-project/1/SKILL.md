# SKR Project Operations v1.0

Use the exact pinned project snapshot and its effective inherited view. Treat inherited records, sources, procedures and policy as read-only. Do not change snapshot metadata or access project store files. Stage proposed local additions in `changeSet`; use only server-approved keys and task permissions. Keep new assertion IDs unique, include versioned dependencies, and preserve parent/source provenance. Never write around optimistic concurrency or policy checks.


## Runtime and tool boundary
The server is authoritative for project and snapshot IDs, scoped source files, runner identity, and publication. The workspace request and snapshot files are informational inputs. Do not invoke a network service, arbitrary paths, or modify authoritative store files. Use the supported output bundle and let the server validate it. Every source-derived statement points to a selected source version and exact region; every conclusion points to all evidence premises.

## Policy and lifecycle
Task request does not grant publication rights. Stage valid `changeSet` entries and preserve lifecycle as staged until server validation and project policy permit commit. Never alter sources, policy, snapshot head, procedure versions, or evidence files directly. Report cancellation, stale snapshot, incomplete scope, and unsupported inputs as explicit errors/residuals.


## Runtime and tool boundary
The server is authoritative for project and snapshot IDs, scoped source files, runner identity, and publication. The workspace request and snapshot files are informational inputs. Do not invoke a network service, arbitrary paths, or modify authoritative store files. Use the supported output bundle and let the server validate it. Every source-derived statement points to a selected source version and exact region; every conclusion points to all evidence premises.

## Policy and lifecycle
Task request does not grant publication rights. Stage valid `changeSet` entries and preserve lifecycle as staged until server validation and project policy permit commit. Never alter sources, policy, snapshot head, procedure versions, or evidence files directly. Report cancellation, stale snapshot, incomplete scope, and unsupported inputs as explicit errors/residuals.
