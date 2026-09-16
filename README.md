# @rethinkingstudio/agent-runner

Starts your coding agent when a job lands on your [Doable](https://doable.rethinking.art)
Agent Desk, so work you hand off from your phone gets picked up in seconds
instead of waiting until you sit down and ask.

MIT. It runs on your machine with access to your code — nobody should run a
closed binary for that.

## Why anything has to run locally

MCP is pull-only, and `claude mcp add` registers a server without starting a
process. But the deeper reason is simpler: **coding agents have no inbox.**
Claude Code, Cursor, Codex — none of them can be told "start working" while
idle. They are invoked, not addressed.

So something local has to be able to *start* a session. This is that something,
and it is deliberately dumb: it notices queued work and shells out. It holds no
state and makes no decisions about the work.

## Setting it up

Ask your agent, in the directory the jobs are about:

> Set up the Doable runner on this machine.

It calls the `setup_runner` MCP tool, gets a command back, and runs it. You never
touch a terminal. Or do it yourself:

```
npx -y @rethinkingstudio/agent-runner install --token dbl_… --cwd ~/code/app --name mac-studio
```

| | |
|---|---|
| `install` | Write settings, register a launchd (macOS) or systemd (Linux) service, start it |
| `watch` | Run in the foreground instead |
| `status` | What it is configured to do, and whether it is running |
| `uninstall` | Stop and remove the service |

Settings live in `~/.doable/runner.json`, mode 600 — outside any repo, because
the token is a credential and `git add -A` should not be able to reach it.

## The default tool list is narrow on purpose

```
mcp__doable__*,Read,Glob,Grep,WebFetch,WebSearch
```

No Write, no Edit, no Bash. These sessions run with nobody watching, so the
default is what a research or writing job needs, and anything that changes files
is something you opt into:

```
npx @rethinkingstudio/agent-runner install --tools "mcp__doable__*,Read,Edit,Write,Bash" …
```

Widen it once you are comfortable with what gets started here, not before.

## Any agent, not just Claude Code

The desk speaks MCP, so anything that speaks MCP can work it. `--exec` is a
plain shell command, and the prompt arrives **on stdin and in `$DOABLE_PROMPT`**,
because CLIs disagree about which they want and neither needs quoting.

```
npx @rethinkingstudio/agent-runner install --exec 'codex exec "$DOABLE_PROMPT"' …
npx @rethinkingstudio/agent-runner install --exec 'my-agent --stdin' …
```

If your agent has no headless mode — a GUI-only assistant — this is not for you,
and nothing is lost: connect it over MCP and work the desk by asking, which is
the default mode anyway.

## How it watches

Long polling. `GET /api/agent/events` is held open for ~25s and answers the
moment the desk moves, so latency is about a second while idle costs one parked
HTTP request. Against a cron recipe that wakes a session every 30 minutes to
find nothing, this is both faster and cheaper.

The polling has not disappeared — it moved to the server, where a database read
is cheap.

## What it will not do

- **Run two sessions at once.** The desk allows one job per machine; a second
  would only be refused.
- **Decide anything about the work.** It passes a fixed prompt and gets out of
  the way. The guardrails — one job, report progress, obey an abort, never mark
  anything done — live in that prompt and in the server's rules.
- **Keep going on a revoked token.** A 401 exits rather than looping. Revoke a
  machine from Account & agents in the app and it stops.

## Turning it off

```
npx @rethinkingstudio/agent-runner uninstall
rm ~/.doable/runner.json
```

Then revoke the machine in the app, which invalidates the token server-side.
