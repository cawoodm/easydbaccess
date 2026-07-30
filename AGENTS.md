# Agents

This repository uses the GitHub Copilot CLI agent model. CLAUDE.md is the authoritative, repository-specific guide—read it first for conventions, policies, and deep details:

- See: ./CLAUDE.md

Quick reference

- Agent types: explore, task, general-purpose, code-review, research, security-review.
- Use direct tools (grep/glob/view/edit) for simple lookups and small edits. Use agents for multi-step, long-running, or specialist work.
- Prefer synchronous (sync) agents for short tasks; background for long-running work where you can do independent actions in parallel.
- Invoke security-review explicitly when investigating exploitable vulnerabilities.
- When prompting agents: provide complete context; agents are stateless and expect full instructions.
- Parallelize independent agent work and other repository tasks when possible.

For examples, exact command patterns, ports, and developer conventions (pre-tool preambles, port rules, commit trailers, and session guidance) see CLAUDE.md.
