# Local Governance Learning Record

This document preserves the project context that Xike Lab studied Paperclip and then adapted selected ideas into local-first panel features.

## Source Context

- Learning source: `/Users/hxx/paperclip`
- Purpose: study Paperclip-style issue tracking, auditability, approval flow, task delegation, and governance surfaces.
- Boundary: Xike Lab did not import Paperclip as a runtime dependency or turn the panel into a Paperclip clone.

## Absorbed Capabilities

The learning was implemented as local, inspectable capabilities:

- Structured activity audit: `src/audit/ActivityLog.js`, `src/server/routes/activity.js`, and the activity modal in `public/app.js`.
- Budget policy and incidents: `src/budget/BudgetPolicyStore.js`, `src/server/routes/budgets.js`, and the overview budget panel.
- Dangerous-command approval queue: `src/approval/ApprovalStore.js`, `src/approval/CommandApprovalGate.js`, `src/server/routes/approvals.js`, and the approval center UI.
- Project context bundle preview: `src/context/ProjectContextBundle.js` and `src/server/routes/projectContext.js`.
- Cross-room local delegation: `src/delegation/DelegationStore.js`, `src/server/routes/delegations.js`, and the delegation center UI.
- Governance summary surface: `src/server/routes/governance.js` and the overview governance panel.
- Gated delegation autostart: `src/autopilot/DelegationAutostart.js`, the `start_delegation` Autopilot job action, `AutopilotScheduleStore.deferRun()`, and `POST /api/delegations/:id/autostart`.

## P3 Gated Delegation Autostart

The local P3 execution path is:

1. A queued delegation can be sent to Autopilot from the Delegation Center with `审批后自启动`.
2. `POST /api/delegations/:id/autostart` creates or reuses a manual approval and queues a `start_delegation` job.
3. `start_delegation` checks the approval gate.
4. If approval is pending, the scheduler defers the job back to `queued` instead of marking it failed.
5. After approval passes, the handler runs budget preflight.
6. If budget is blocked, the job is deferred again and the budget incident remains visible.
7. When approval and budget both pass, the delegation is executed into a target room with lineage.
8. If `autoStart !== false` and the target room is not chat, the matching dispatcher starts the target room.

Latest verification:

- `npm test` passed: 44 test files, 228 tests.
- `npm run lint` passed.
- `git diff --check` passed.
- `npm run test:e2e` passed: 47/47.
- Temporary HTTP smoke on port `52000` verified approval-pending deferral, approval pass, job success, delegation creation, and target-room lineage.
- Browser smoke verified the Delegation Center `审批后自启动` action creates a pending approval and opens Approval Center.

## Dirty Worktree Handling

The current worktree is intentionally large because the local governance absorption was implemented as a connected set of primitives. Do not solve this with `git reset --hard`, broad checkout, or `git add .`.

Recommended cleanup path:

1. Keep the current tree intact until a commit decision is made.
2. Split commits by functional boundary:
   - `audit/activity`: ActivityLog, `/api/activity`, audit viewer, related tests.
   - `budget/approval`: budget policies/incidents, approval store/gates/UI, related tests.
   - `context/lineage`: ProjectContextBundle, objective/lineage, role cards, report injection, related tests.
   - `autopilot-scheduler`: schedules/jobs/runs, scheduler, deferred jobs, route tests.
   - `delegation`: DelegationStore, delegation routes/UI, autostart gate, related tests.
   - `governance-overview`: `/api/governance/summary`, Overview governance card, responsive fixes.
   - `docs/e2e`: this learning record and walkthrough coverage updates.
3. Stage with explicit file lists only.
4. Before each commit slice, run `git diff --check`, targeted tests, `npm test`, and `npm run lint`.
5. Only squash everything if the user explicitly wants one large integration commit.

## Preservation Rule

Do not delete these local governance, approval, audit, budget, context, or delegation features just because the Paperclip label is removed from comments or filenames.

If the user asks to remove Paperclip references, interpret that as removing branding/provenance labels from runtime code unless they explicitly ask to remove the learned feature implementations too.
