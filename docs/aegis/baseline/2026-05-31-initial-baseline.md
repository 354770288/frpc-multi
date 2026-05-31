# Initial Baseline Snapshot

Date: 2026-05-31

## Project Structure
- Root deployment files: `compose.console.yaml`, `compose.agent.yaml`, `compose.yaml`, `compose.generated.yaml`.
- Frontend: `webui/frontend/src`, React + Vite + Tailwind.
- Backend: `webui/backend/app`, FastAPI control plane and local Agent service.
- Docs: `README.md`, `webui/README.md`, `docs/*.md`.
- Scripts: `scripts/*.sh` for deploy, install, backup, health checks, and tuning.

## Tech Stack
- Frontend: React 19, TypeScript, Vite, Tailwind CSS v4, lucide-react.
- Backend: FastAPI, SQLite control database, WebSocket Console/Agent protocol, Docker Compose execution through Agent.
- Tests: Python `unittest` under `webui/backend/tests`.

## Ownership Mapping
- App authentication shell: `webui/frontend/src/App.tsx`.
- Console page routing and global summary polling: `webui/frontend/src/Console.tsx`.
- Frontend API client and contracts: `webui/frontend/src/lib/api.ts`, `webui/frontend/src/lib/types.ts`.
- Current frontend pages: `webui/frontend/src/pages/*.tsx`.
- Reusable UI components: `webui/frontend/src/components/**`.
- Console APIs and summary aggregation: `webui/backend/app/main.py`, `webui/backend/app/control/router.py`.
- Node persistence and audit persistence: `webui/backend/app/control/node_store.py`, `webui/backend/app/control/audit_store.py`.
- Agent runtime execution: `webui/backend/app/agent/service.py`.

## Contract Inventory
- Browser calls only Console APIs under `/api/*`.
- Agent machines connect out to Console through `/ws/agent`; Console does not call remote Docker directly.
- Instance identity is `nodeId + instanceName`.
- Instance configuration source of truth remains Agent-local `instances/<name>/frpc.toml`.
- Frontend summary consumes `/api/summary`, which aggregates node status and instance runtime state.

## Dependency Direction
- Frontend components depend on `lib/api.ts` and `lib/types.ts`; they do not call backend internals directly.
- Console APIs depend on NodeStore, AuditStore, and Agent hub.
- Agent service owns local file and Docker Compose side effects.

## Test System
- Backend coverage exists for instance validation, compose generation, Console/Agent contracts, node cleanup, auth behavior, and audit-related paths.
- Frontend has TypeScript build verification through `npm run build`; no dedicated component or browser tests are present.

## Build And Deploy
- Frontend build: `cd webui/frontend && npm run build`.
- Backend tests: `cd webui/backend && python3 -m unittest discover -s tests`.
- Console deploy uses `compose.console.yaml`.
- Agent deploy uses generated install command and `compose.agent.yaml`.

## Known Anti-Patterns
- UI page navigation currently mirrors implementation modules more than operator workflows.
- Instance selection is hidden global state in `Console.tsx`; some pages require prior selection but do not expose that dependency clearly.
- High-risk operations mostly rely on browser `confirm`, which is hard to style and provides weak context.
- Large tables are desktop-oriented and have limited filter/view controls.
- Node, instance, logs, and config workflows are split across separate pages with repeated context reacquisition.

## Compatibility Boundaries
- Do not require backend contract changes for a first frontend redesign unless explicitly approved.
- Preserve login/session behavior and current authorization header handling.
- Preserve Console/Agent reverse connection model and node-scoped instance identity.
- Preserve raw TOML editing for advanced frpc fields, while making structured editing safer.
