# Frontend Page Redesign Brief

Date: 2026-05-31

This spec records the product/design direction for a frontend page redesign of the frpc-multi Console after the backend was split into Console + Agent. The user-facing draft is also available at `docs/FRONTEND_REDESIGN_PLAN.md`.

## TaskIntentDraft
- Outcome: summarize the current frontend functions and define a page redesign plan that can be used to generate frontend mockups.
- Goal: make common Console workflows easier after frontend/backend separation, without inventing backend capabilities that do not exist.
- Success evidence: the plan covers existing functions, identifies current usability gaps, proposes a workflow-centered information architecture, and gives page-level visual instructions for mockup generation.
- Stop condition: deliver a review-ready plan document; no frontend implementation in this step.
- Non-goals: no code rewrite, no backend API change, no new multi-tenant permission model, no alert/backup feature design beyond current documented future work.
- Risks: generated mockups may over-emphasize decorative dashboard visuals; the plan must keep an operations-console density and show real frpc objects first.

## BaselineReadSetHint
- `README.md`
- `webui/README.md`
- `docs/PHASE-2.md`
- `webui/frontend/src/Console.tsx`
- `webui/frontend/src/pages/*.tsx`
- `webui/frontend/src/lib/api.ts`
- `webui/frontend/src/lib/types.ts`
- `webui/backend/app/main.py`

## ImpactStatementDraft
- Affected layers: frontend navigation, page layouts, instance detail workflow, node management page, config editor UX, empty/error/loading states.
- API boundary: use current `/api/*` contracts first; defer backend extensions.
- Runtime boundary: Console remains control plane, Agent remains execution side.
- Invariants: instance identity is `nodeId + name`; raw TOML remains available; high-risk actions require confirmation.
- Compatibility: old pages can be refactored incrementally behind the same `Console.tsx` shell.

## Product Risk Lens
- Value: reduce cross-page friction for daily operations: find unhealthy instance, inspect logs, edit config, restart safely, manage node lifecycle.
- Non-goals: do not turn this into a marketing dashboard or a full observability product.
- Trade-offs: a denser operations UI is less visually flashy but more useful for repeated admin work.
- Decision needed: adopt workflow-centered IA instead of simply restyling current pages.

## Baseline Role Alignment
- Product / Requirement Baseline: Console is a lightweight operations panel for nodes and frpc instances.
- Architecture / Runtime Boundary Baseline: frontend calls Console APIs only; Console forwards to online Agents.
- Result: aligned.
- Scope: requirements and architecture.
- Next action: generate mockups from the plan, then return for implementation planning.

## Plan-Time Complexity Check
- Better file boundary: keep shared shell/navigation in `Console.tsx`, extract new page-level components only where workflow ownership is clear.
- Recommendation: split task after mockups into incremental frontend refactor slices.

## Options
1. Restyle existing pages only.
   - Pros: lowest implementation risk.
   - Cons: keeps current workflow fragmentation and hidden selection problems.
2. Workflow-centered IA with existing API contracts.
   - Pros: fixes the main usability issue while keeping backend stable.
   - Cons: requires moderate frontend restructuring.
3. Node-centric redesign with backend extensions.
   - Pros: strong fit for distributed Agent architecture.
   - Cons: larger scope and premature API expansion before mockups are validated.

Recommendation: option 2. It is the best balance for the next frontend upgrade.

## Design Direction
- Use a quiet operations-console visual style: dense tables, clear status chips, compact cards, right-side context drawers, and full-width page sections.
- Make `Instances` the main daily workspace, not a secondary detail hidden behind `Overview`.
- Convert `Config` from a top-level nav item into an instance-scoped tab or drawer.
- Add visible node and instance context to every workflow.
- Keep destructive and disruptive actions visually distinct and confirmation-rich.
- Support desktop-first operations while making mobile views usable through stacked cards and bottom/action drawers.

## Acceptance For Mockup Review
- Mockups show real page names and real entities: nodes, instances, proxies, logs, config validation, audit records.
- Instance detail includes tabs or sections for health, logs, config/proxies, and operations.
- Create/edit instance flow shows node selection, frps connection, proxy setup, validation, and start behavior.
- Node page shows online status, install command, rotate secret, Agent upgrade, and delete path.
- No mockup depends on a backend feature not listed in the existing function summary.

## Spec Self-Review
- Placeholder scan: none.
- Internal consistency: frontend redesign is constrained to current Console/Agent architecture.
- Scope check: ready for mockup generation, not yet an implementation plan.
- Ambiguity check: recommended IA and non-goals are explicit.
- Boundary check: API and runtime boundaries are recorded.
