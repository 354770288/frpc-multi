# Node-First Frontend Workspace Implementation Plan

Date: 2026-05-31

## Goal
Implement the first frontend upgrade slice from `docs/mockups/node-first-dense-workspace.html`: make the main Console page a node-first dense workspace where operators select a node first, then operate instances in that node scope.

## Architecture
- Console remains the browser-facing control plane.
- Agents remain execution-side only; the frontend must not call Agent endpoints directly.
- `Console.tsx` owns page routing, summary loading, selected node/instance state, and existing API actions.
- `Overview.tsx` owns the node-first workspace rendering and filtering.
- Node lifecycle actions such as install command, secret rotation, Agent upgrade, and node deletion stay in `NodesPage`; the workspace links there rather than duplicating those operational flows.

## Tech Stack
- React 19 + TypeScript + Vite.
- Tailwind CSS v4 utility classes and existing CSS tokens.
- Existing `api` and `nodesApi` client wrappers only.

## Baseline/Authority Refs
- `docs/aegis/specs/2026-05-31-frontend-redesign-brief.md`
- `docs/FRONTEND_REDESIGN_PLAN.md`
- `docs/mockups/node-first-dense-workspace.html`
- `webui/frontend/src/Console.tsx`
- `webui/frontend/src/pages/Overview.tsx`
- `webui/frontend/src/lib/api.ts`
- `webui/frontend/src/lib/types.ts`

## Compatibility Boundary
- No backend API changes.
- Instance identity remains `nodeId:name`.
- Existing detail, config, create, nodes, audit, and system pages remain routable.
- Destructive actions continue to use the existing action handlers in this slice; richer confirmation modals are deferred.

## Verification
- Run `npm run build` from `webui/frontend`.
- Start the backend and frontend dev servers if needed for visual inspection.

## Tasks
1. Update the Console shell to remove the persistent sidebar and pass node/workspace navigation props to `Overview`.
2. Update the topbar to match the no-sidebar mockup: brand, global search placeholder, profile menu with audit/system/logout, and optional create-instance action.
3. Replace the overview content with the node-first workspace: metrics strip, node cards, selected node context, scoped instance filters, status tabs, and dense table.
4. Keep existing instance actions wired to the same handlers and route log/config/deeper inspection to existing pages.
5. Build and visually verify the result.

## Risks
- The backend summary currently exposes instance runtime but not full node system metrics; this slice must display only available node and instance data instead of inventing Docker/frpc versions.
- Without a test framework, compile/build plus browser inspection is the strongest available frontend verification.

## Retirement
- The old sidebar-centered overview is retired in this slice.
- The existing `NodesPage` remains the canonical owner for node lifecycle commands until a later approved design moves those flows into a drawer.
