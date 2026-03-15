# Decision OS MCP

MCP server for Decision OS — an LLM-native decision tracking and learning system. TypeScript, Node.js 18+, ES modules, `@modelcontextprotocol/sdk`, YAML storage, Zod validation.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript (tsc)
npm run dev          # Watch mode (tsc --watch)
npm test             # Run all tests (vitest run)
npm run test:watch   # Watch tests (vitest)
npm start            # Run server (set DECISION_OS_PATH first)
```

Run `npm run build && npm test` before committing. All tests must pass.

## Architecture

```
src/
├── index.ts                       # Public API surface (re-exports)
├── core/
│   ├── schemas.ts                 # Zod schemas for all types (Decision OS + Observer)
│   ├── storage.ts                 # Single-scope storage engine (YAML read/write)
│   ├── hierarchical-storage.ts    # Multi-scope storage (PROJECT + GLOBAL cascading)
│   └── services.ts                # Thin service layer over storage (used by observer)
├── observer/
│   ├── engine.ts                  # observe(state, newTurns) → events + actions
│   ├── state.ts                   # ObserverMetaState creation + event reducer
│   ├── projections.ts             # Map observer actions → Decision OS core calls + feedback
│   ├── orchestrator.ts            # Full cycle: detect → project → feedback → persist
│   └── persistence.ts             # Save/load observer sessions as JSON
├── integrations/
│   └── litellm/
│       └── callback-handler.ts    # LiteLLM callback → observer orchestrator
└── server/
    └── index.ts                   # MCP server entry, tool definitions, request handler
test/
├── storage.test.ts
├── hierarchical-storage.test.ts
└── observer.test.ts
templates/                         # Setup templates for consumers
```

### Core
- Entry point registers 13 MCP tools via `@modelcontextprotocol/sdk`
- All tool input validation uses Zod schemas from `core/schemas.ts`
- Storage is YAML-based, file-system only, no network calls
- Hierarchical storage merges `~/.decision-os/` (GLOBAL) with project-level `.decision-os/` (PROJECT)
- PROJECT scope wins over GLOBAL on conflicts
- `DecisionOSService` provides a programmatic API over storage (no MCP dependency)

### Observer
- Session-local meta-state tracks task stage, case lifecycle, and pressure signals
- `observe()` processes new conversation turns incrementally (not full conversation)
- V1 uses heuristic detection for 3 transitions: TASK_START, PRESSURE_DETECTED, COMPLETION_SIGNAL
- `projectActions()` maps observer actions into Decision OS core calls via the service layer
- `toFeedbackEvents()` converts projection results back into state events (CASE_OPENED, CASE_CLOSED)
- `runCycle()` composes the full loop: detect → project → feedback → state update
- `ObserverOrchestrator` wraps `runCycle()` with persistence load/save
- Observer state persists under `.decision-os/observer/sessions/` as JSON
- **Core never imports from observer.** Observer calls core through the service layer.

### LiteLLM Integration
- `LiteLLMCallbackHandler` converts LiteLLM callback events into ObserverTurns
- Normalizes roles (user/assistant/tool), skips system messages
- Feeds turns through the ObserverOrchestrator on each successful callback

## Conventions

- ES modules (`"type": "module"` in package.json) — use `.js` extensions in imports
- Strict TypeScript (`strict: true`, target ES2022, NodeNext module resolution) — no `any`, no `@ts-ignore`
- Tool definitions in `TOOLS` array follow MCP SDK `Tool` type with `annotations`
- All tool handlers live in the `switch` block inside `CallToolRequestSchema` handler
- Zod for all input validation; errors formatted as `path: message`
- Error handling: `ZodError` → formatted validation message; `Error` → `.message`; else → `String(error)`
- Regret values accept both number (0-3) and string ("0"-"3") via `z.preprocess`
- Foundation IDs: `F-NNNN` (project), `GF-NNNN` (global)
- Pressure event IDs: `PE-NNNN`
- Case IDs: `NNNN-slug-title`

## Testing

- Tests use Vitest with temp directories for isolation
- Test files: `test/storage.test.ts`, `test/hierarchical-storage.test.ts`, `test/observer.test.ts`

## Adding a New Tool

1. Add input schema to `core/schemas.ts`
2. Add `Tool` definition to `TOOLS` array in `server/index.ts` (include `annotations`)
3. Add handler case to the `switch` block in the `CallToolRequestSchema` handler
4. Add tests in `test/`
5. Update tool table in `README.md`

## PR Guidelines

- Title format: descriptive summary of the change
- Run `npm run build && npm test` before opening a PR
- Include test coverage for new tools or storage logic
- Update `README.md` tool table if adding/removing tools
