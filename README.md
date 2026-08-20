# Wardroom

Wardroom is an open-source, local-first orchestrator for disciplined AI
development. It runs two Claude agent roles over your git repository: a
Product Manager that owns scope and canonical documents, and an Implementer
that writes code and tests. You keep command, so work proceeds
autonomously in bounded, test-gated iterations, and only critical actions
(pushing, deploying, changing scope, destructive operations) stop and wait
for your approval.

The name: a wardroom is the room on a warship where the officers plan and
report. The crew works there. The captain, you, keeps command.

## Status

**Pre-alpha, under active development. Nothing runnable exists yet.** This
repository currently holds the project's public skeleton while the core is
being built. Watch the repo if the idea interests you.

## Why

Autonomous coding agents fail in two directions. "Issue in, PR out" agents
produce large, unreviewable changes and lose their state to context limits.
Heavyweight multi-agent frameworks bury project state in databases you
can't read or fix. Wardroom takes a third path:

- **All durable state lives in repository files.** Plain, versionable
  markdown, with no hidden databases and no session memory to lose. Kill the
  process at any moment; it resumes from the repo.
- **Documents before code.** Scope, requirements, and decisions are written
  and human-approved before implementation runs.
- **Bounded iterations that must close green.** Full test suite, reversed
  order, lint and types, or the iteration doesn't close.
- **Human command, not human babysitting.** You approve gates, not every
  step.

## Planned shape

- Single core with pluggable control surfaces: CLI first; Telegram bot and
  MCP server later, so you can supervise from a phone or from Claude chat.
- Local-first: your machine or your own server, your own Anthropic
  credentials. No central service, no telemetry, no account.
- Built on the Claude Agent SDK. Claude-only by design.

## License

MIT. See [LICENSE](LICENSE).
