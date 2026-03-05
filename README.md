# Decision OS MCP

An MCP server for **Decision OS** — an LLM-native decision tracking and learning system.

## What is Decision OS?

Decision OS captures **novel pressure** — moments when reality surprises you during engineering work. Unlike traditional documentation, it focuses on what an LLM couldn't predict, creating a learning loop:

```
Cases → Pressure Events (surprises) → Outcomes → Foundations (compressed learnings)
```

## Quick Start

### 1. Install the MCP Server

```bash
# Global install
npm install -g decision-os-mcp

# Or use npx (no install needed)
npx decision-os-mcp
```

### 2. Add to Your Project

Copy the template to your project:

```bash
cp -r templates/.decision-os /path/to/your-project/
```

Edit `config.yaml` with your project name.

### 3. Configure Your Agent

#### Cursor

Add to your project's `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "decision-os": {
      "command": "npx",
      "args": ["-y", "decision-os-mcp"],
      "env": {
        "DECISION_OS_PATH": "${workspaceFolder}/.decision-os"
      }
    }
  }
}
```

Copy the Cursor rules template:

```bash
cp templates/.cursor/rules/decision-os.mdc /path/to/your-project/.cursor/rules/
```

#### Claude Code / Claude Desktop

Add to your Claude Desktop config (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS):

```json
{
  "mcpServers": {
    "decision-os": {
      "command": "npx",
      "args": ["-y", "decision-os-mcp"],
      "env": {
        "DECISION_OS_PATH": "/absolute/path/to/your-project/.decision-os"
      }
    }
  }
}
```

Copy the agent instructions template (includes a `.claude/rules/` symlink to AGENTS.md):

```bash
cp templates/AGENTS.md /path/to/your-project/
cp -R templates/.claude /path/to/your-project/
```

> **Note:** Claude Desktop requires absolute paths in `DECISION_OS_PATH` (no `${workspaceFolder}`).

[AGENTS.md](https://agents.md) is an open standard supported by 20+ coding agents including OpenAI Codex, Google Jules, Claude Code, Cursor, Aider, Zed, Warp, VS Code, and more. The `.claude/rules/` symlink lets Claude Code pick it up automatically too — one file, every agent.

## Tools

| Tool | Description |
|------|-------------|
| `get_context` | Get active case, recent pressures, foundations ranked by relevance, conflicts |
| `log_pressure` | Log a pressure event when reality differs from expectation |
| `quick_pressure` | Quick-capture a pressure event with minimal friction (only expected + actual required) |
| `create_case` | Create a new case (unit of work) |
| `close_case` | Close a case with outcome signals and regret score (auto-forgets successful cases) |
| `set_active_case` | Set the active case for the session (persists across restarts) |
| `get_foundations` | Query foundations from project and global scopes |
| `search_pressures` | Search past pressure events |
| `check_policy` | Check what policy requires for given signals |
| `promote_to_foundation` | Promote pressure events to a foundation (PROJECT or GLOBAL scope) |
| `elevate_foundation` | Elevate a project foundation to global scope |
| `validate_foundation` | Validate that a global foundation applies in current project |
| `suggest_review` | Review project for unextracted learnings and forgetting opportunities |
| `list_cases` | List all cases in the project |

## Core Concepts

### Pressure Events

The primary learning artifact. Logged when something unexpected happens:

```yaml
expected: "Supabase insert would throw on null FK"
actual: "RLS silently blocked the write, no error"
adaptation: "Added explicit null-check before insert"
remember: "Supabase RLS fails silently on null FK values"
```

### Foundations

Compressed learnings promoted from repeated pressure events:

```yaml
id: F-0001
title: "Supabase RLS fails silently on null FK"
default_behavior: "Always validate FK values before insert when using RLS"
context_tags: [SUPABASE, RLS, DATA_MODEL]
confidence: 2  # Out of 3
scope: PROJECT  # or GLOBAL
origin_project: my-project
validated_in: [my-project, other-project]
exit_criteria: "Supabase adds explicit error for null FK violations"
source_pressures: [PE-0003, PE-0007]
```

### Hierarchical Foundations (GLOBAL -> PROJECT)

Decision OS supports a cascading scope model similar to Git config:

```
~/.decision-os/                    # GLOBAL (user-wide, universal learnings)
├── config.yaml
└── defaults/foundations.yaml      # GF-prefixed foundations

~/projects/my-app/.decision-os/    # PROJECT (specific to this codebase)
├── config.yaml
├── cases/
└── defaults/foundations.yaml      # F-prefixed foundations
```

**Resolution order**: PROJECT wins over GLOBAL on conflicts.

**Global foundations are recommendations, not rules.** They represent universal patterns that transcend specific tech stacks:
- Tool behaviors (e.g., "MCP descriptor paths may be stale")
- Debugging strategies (e.g., "Trace call sites before refactoring")
- Meta-learnings (e.g., "Question requirements before implementing")

**Setup global foundations:**

```bash
# Create global .decision-os
mkdir -p ~/.decision-os/defaults
cp templates/global-.decision-os/config.yaml ~/.decision-os/
cp templates/global-.decision-os/defaults/foundations.yaml ~/.decision-os/defaults/
```

**Conflict detection**: When `get_context` is called, it highlights conflicts where project and global foundations overlap or contradict each other.

### Cases

Bounded units of work (feature, bugfix, spike) that provide context for pressure events:

```yaml
id: 0001-add-tile-caching
title: "Add tile caching"
goal: "Reduce API latency for repeated tile requests"
status: ACTIVE
signals:
  context:
    risk_level: MEDIUM
    affected_surface: [PERFORMANCE_CRITICAL, INTEGRATION]
decisions:
  approach: BUILD
  posture: BALANCED
  validation_level: STANDARD
```

## Directory Structure

```
# Global (user-wide)
~/.decision-os/
├── config.yaml               # scope: GLOBAL
└── defaults/
    └── foundations.yaml      # GF-prefixed universal learnings

# Project (per-codebase)
your-project/
├── .decision-os/
│   ├── config.yaml           # scope: PROJECT
│   ├── cases/
│   │   ├── 0001-bootstrap/
│   │   │   ├── case.yaml     # Case metadata
│   │   │   └── pressures.yaml # Pressure events
│   │   └── 0002-add-auth/
│   │       └── ...
│   └── defaults/
│       └── foundations.yaml  # F-prefixed project learnings
├── .cursor/                  # Cursor setup
│   ├── mcp.json              # MCP server config
│   └── rules/
│       └── decision-os.mdc   # LLM instructions (Cursor format)
├── .claude/                  # Claude Code setup
│   └── rules/
│       └── decision-os.md    # -> symlink to ../../AGENTS.md
├── AGENTS.md                 # Agent instructions (Claude Code, Codex, Jules, etc.)
└── src/
```

## LLM Workflow

1. **At task start**: Call `get_context()` to load active case and foundations (ranked by relevance)
2. **When surprised**: Call `quick_pressure()` for fast capture or `log_pressure()` for full detail
3. **Before BUILD decisions**: Call `check_policy()` to see requirements
4. **At task end**: Call `close_case()` with regret score
5. **Periodically**: Call `suggest_review()` to find unextracted learnings and forgetting opportunities

## Forgetting

The system forgets by design. Cases are temporary containers — knowledge lives in foundations.

When `close_case()` is called with **regret 0** and there are **no unpromoted pressure events**, the case is automatically deleted. Not archived. Forgotten.

This keeps the `.decision-os/cases/` directory lean: only cases that still have uncompressed learning (unpromoted PEs or regret 1+) survive.

The lifecycle:
1. **Cases are born** when work starts
2. **Pressure events are captured** when surprises happen
3. **PEs are promoted** to foundations when patterns emerge
4. **Cases are forgotten** when they have nothing left to teach
5. **Foundations survive** as the only persistent knowledge

Use `suggest_review()` to find cases blocking forgetting (regret 0 but unpromoted PEs remain) and decide whether to promote or discard them.

## Active Case Persistence

The active case is persisted to `.decision-os/.active-case` and survives MCP server restarts. No more losing your active case when Cursor restarts.

## Signals Vocabulary

### Context Signals (before execution)
- `risk_level`: LOW / MEDIUM / HIGH
- `reversibility`: EASY / MEDIUM / HARD
- `change_frequency`: RARE / OCCASIONAL / FREQUENT
- `affected_surface`: CORE_DOMAIN / INTEGRATION / DATA_MODEL / INFRA_DEPLOY / SECURITY_BOUNDARY / UI_UX / PERFORMANCE_CRITICAL
- `novelty`: LOW / MEDIUM / HIGH

### Decisions
- `approach`: REUSE / REFRAME / BUILD / HYBRID
- `posture`: MINIMAL / BALANCED / ROBUST
- `validation_level`: BASIC / STANDARD / STRICT

### Outcome Signals
- `regret`: 0-3 (0 = would choose same, 3 = strong regret)
- `regressions`: NONE / MINOR / MAJOR

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run locally
DECISION_OS_PATH=/path/to/.decision-os npm start
```

## Philosophy

- **Log only novel pressure**: Don't document what an LLM could derive
- **The system should forget**: Successful cases are deleted. Knowledge lives in foundations, not cases
- **Hypotheses, not axioms**: Foundations have confidence and can be revised
- **Minimal ceremony**: Small vocabulary, structured but not bureaucratic
- **Capture first, filter later**: When unsure, log it — capturing too much is better than missing surprises
- **LLM-native**: Designed for AI-assisted engineering workflows

## License

MIT
