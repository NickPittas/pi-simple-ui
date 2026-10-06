# ORCHESTRATOR.md — <project>

> Project memory for the orchestrator role. Single writer: the orchestrator.
> Subagents receive slices via prompts; they never edit this file.
> No secrets in this file. Keep under ~400 lines; collapse finished work to §7.
>
> Last updated: YYYY-MM-DD · Session/agent: <who>

## 1. Repo Brief

### Stack
- Language / framework / versions:
- Package manager:

### Commands (exact, copy-paste ready)
- Dev server:
- Build:
- Typecheck:
- Lint / format:
- Tests (all):
- Tests (single file):
- UI / e2e tests:

### Structure
- Directory map (top two levels) and what lives where:
- Module boundaries (who may import whom):

### Design system
- Component library:
- Theme / token files:
- Exemplars — copy these patterns:
  - Form example: src/features/settings/SettingsForm.tsx
  - List/table example:

### Reusable utilities (never reimplement these)
| Concern | Where | Notes |
|---|---|---|
| HTTP client | src/lib/http.ts | all API calls go through this |
| Validation | src/lib/schema.ts | zod schemas live here |
| Toast/errors | src/lib/toast.ts | pattern at line 14 |

### Config & secrets
- Env vars live in: .env.local (never committed)
- Never commit: .env*, service keys, dumps

## 2. Conventions
- Naming: components PascalCase, hooks use*, tests *.test.ts
- Commits: conventional commits; one task = one commit
- Branches: feat/<task-id>-<slug>, branch-off origin/main
- Style rules that matter:

## 3. Decision Log (append-only; mark superseded, never delete)
| Date | Decision | Rationale | Scope | Status |
|---|---|---|---|---|
| YYYY-MM-DD | Drizzle over Prisma | existing partial usage; user preference | data layer | settled |
| YYYY-MM-DD | | | | |

## 4. Task Ledger (active tasks only)
| ID | Title | Status | Worker | Workspace | Files in scope | DoD | Review |
|---|---|---|---|---|---|---|---|
| T-007 | Token validation middleware | in-progress | codex/… | ws-abc | src/auth/validate.ts | tests green + reviewer approve | — |

Status: todo / in-progress / review / done / blocked.
Completed tasks move to §7 after their review closes.

## 5. Open Questions / Parking Lot
- [ ] Q: default session TTL? — needs: user — asked: YYYY-MM-DD
- [ ] Q: where is the invoice PDF pipeline? — needs: explorer

## 6. Lessons Learned (delegation)
- Workers kept hunting for the HTTP client → now every API-task anchor includes src/lib/http.ts.
- Test command for auth area differs: `pnpm test --filter auth` — record per-area commands above.

## 7. Archive (one line per completed task)
- T-006 done YYYY-MM-DD: callback route src/auth/callback.ts — approved after 1 review cycle.
