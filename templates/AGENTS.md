# Decision OS

You have access to Decision OS MCP tools for tracking decisions and learning from novel pressure.

## Workflow

1. **Task start**: Call `get_context()` to load active case, foundations, and conflicts. Create a case with `create_case()` if none exists.
2. **When surprised**: Call `quick_pressure({ expected, actual })` for fast capture or `log_pressure({ expected, actual, adaptation, remember })` for full detail. When in doubt, capture it.
3. **Before BUILD decisions**: Call `check_policy({ signals })` to check requirements.
4. **Task end**: Call `close_case()` with regret (0-3), notes, and regressions. Cases with regret 0 and no unpromoted PEs are auto-deleted.
5. **Periodically**: Call `suggest_review()` to find unextracted learnings.

## When to Log Pressure

- Something failed that you predicted would work
- You changed approach mid-implementation
- You discovered an undocumented constraint
- A library behaved differently than expected
- Performance was unexpectedly poor or good

## Tools

| Tool | Purpose |
|------|---------|
| `get_context` | Load active case, foundations, conflicts |
| `quick_pressure` | Fast pressure capture (expected + actual only) |
| `log_pressure` | Full pressure capture with adaptation and remember |
| `create_case` | Start a new unit of work |
| `close_case` | Close with outcome signals |
| `set_active_case` | Switch active case |
| `check_policy` | Check policy requirements for signals |
| `get_foundations` | Query compressed learnings |
| `search_pressures` | Search past pressure events |
| `promote_to_foundation` | Promote PEs to foundation |
| `elevate_foundation` | Elevate project foundation to global |
| `validate_foundation` | Validate global foundation in current project |
| `suggest_review` | Find unextracted learnings |
| `list_cases` | List all cases |
