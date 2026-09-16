# Codex CLI as a second reader

Optional. Nothing in the gate depends on it. It exists so a model that did not
write the change can read it — the class of defect that survives a green gate is
the one nobody thought to write a test for.

The integration is deliberately thin: `.claude/skills/codex/SKILL.md` tells
Claude when and how to shell out to `codex exec -s read-only`, and
`.claude/settings.json` allowlists exactly those read-only invocations so they
do not prompt. There is no MCP server and no wrapper package.

## Why not MCP

The widely circulated recipe is to register Codex with Claude Code as an MCP
server:

```jsonc
// Does NOT work on current Codex.
{ "mcpServers": { "codex": { "command": "codex", "args": ["mcp-server"] } } }
```

Verified against `codex-cli 0.154.0`: there is no `mcp-server` subcommand. The
`codex mcp` subcommand points the other way — it manages external MCP servers
that *Codex* consumes (`list`, `get`, `add`, `remove`, `login`, `logout`). The
serve mode those guides describe existed in earlier builds and is not in the
current CLI's command list.

Third-party wrappers re-expose the CLI over MCP. They are unaudited and would
hold tool access to this repo, so they are not used here. `codex exec` is
first-party and does the same job through Bash.

## Local setup

Node 22+ is required (this repo already pins `>=24`).

```bash
npm install -g @openai/codex
codex login          # Sign in with ChatGPT (Plus/Pro/Business/Edu/Enterprise)
codex --version
codex doctor         # expect auth ✓ and reachability ✓
```

An `OPENAI_API_KEY` in the environment works instead of `codex login`, and is
billed per token rather than against a ChatGPT plan. Do not commit it; this repo
loads secrets from `.env.local` / `.env.test`, both gitignored.

Then, from a session in this repo, ask for a second opinion and the skill picks
it up. To confirm the wiring end to end:

```bash
git diff | codex exec -s read-only --skip-git-repo-check \
  -o /tmp/codex-review.md "Summarize this diff in three sentences."
cat /tmp/codex-review.md
```

## Claude Code's remote sandbox

Codex installs there but cannot run. Measured in a remote session on
2026-09-16:

```
$ curl -s -o /dev/null -w "%{http_code}\n" https://api.openai.com/v1/models
000
$ codex doctor
✗ auth          no Codex credentials were found
✗ reachability  one or more required provider endpoints are unreachable over HTTP
```

The environment's egress proxy does not allow `api.openai.com` or
`chatgpt.com`, and the container is reclaimed at session end, so a global npm
install does not persist either. Enabling it there needs two changes to the
environment, both made in the Claude Code web UI rather than in this repo:
`api.openai.com` added to the network policy, and `OPENAI_API_KEY` set as an
environment variable. See
<https://code.claude.com/docs/en/claude-code-on-the-web>.

Until then the skill's `codex doctor` precheck fails closed and Claude does the
review itself rather than reporting an opinion it never got.

## The read-only rule

Every invocation in the skill passes `-s read-only`. Codex reports; Claude
applies the change through the normal path — gate, `docs/PROGRESS.md` entry,
`C-NNN:` commit, recorded SHA. A second agent writing files directly would skip
all of that, and the invariant most likely to die first is the snapshot rule: an
outside reader has no reason to know that `OrderLine` must never join back to
`MenuItem`.

The allowlist in `.claude/settings.json` is matched by literal prefix, so
`Bash(codex exec -s read-only:*)` covers exactly that flag in exactly that
position. A `codex exec` without it, or with `-s workspace-write`, does not
match and still prompts. That is the intended behavior — keep it that way.
