# Breathing

Breathing gives a voice to AI coding agents. It is a macOS menu bar app. Agents such as Claude Code and Codex connect to it through MCP. When an agent finishes work, it says a short message, like a coworker: what it did, what is important, and where to look. The voice does not read the output.

- Speech runs locally with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (`kokoro-js`, ONNX). No cloud and no API key.
- One app serves all agents. Messages go into one queue, so voices never overlap.
- A floating orb breathes while idle and moves with the voice while it speaks. It shows who speaks and the current sentence.

## Requirements

- macOS on Apple Silicon (Intel works, but is slower).
- Node.js 20 or later to build.
- About 100 MB of disk for the voice model. The app downloads it on the first start.

## Build and run

```bash
npm install
```

```bash
npm start
```

The first start downloads the model to `~/Library/Application Support/Breathing/models`. The orb shows a progress ring. When the ring is full, the voice is ready.

To make a `.app` bundle in `dist-app/`:

```bash
npm run dist
```

## Connect your agents

### Automatic

Open the menu bar icon and click **Install for Claude Code and Codex…**. The app shows the exact changes and asks before it writes them:

- **Claude Code**: `claude mcp add --scope user --transport http breathing http://127.0.0.1:48613/mcp`, and the skill in `~/.claude/skills/breathing/`.
- **Codex**: a `[mcp_servers.breathing]` block in `~/.codex/config.toml` that starts the stdio bridge, and the skill in `~/.codex/skills/breathing/`.

Start a new agent session after the install.

### Manual

The app runs an MCP server with Streamable HTTP on `http://127.0.0.1:48613/mcp`. Use this URL in any client that supports HTTP MCP servers.

For clients that only support stdio, use the bridge. It forwards calls to the app, and it starts the app if it does not run:

```json
{
  "command": "/Applications/Breathing.app/Contents/MacOS/Breathing",
  "args": ["/Applications/Breathing.app/Contents/Resources/app.asar/dist/bridge/bridge.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

Copy `skill/breathing/SKILL.md` to the skills folder of your client.

## MCP tools

| Tool | Input | What it does |
|---|---|---|
| `speak` | `text`, `kind` (`summary`, `progress`, `attention`), `interrupt` | Puts a message in the queue and returns at once. Returns `muted: true` if the user muted the app. |
| `stop` | none | Stops the voice and clears the queue. |
| `status` | none | Muted, model state, speaking, queue length, current sentence, voice, speed. |

The server also sends short speech rules as MCP server instructions. So an agent knows the rules even when it does not load the skill.

### Queue rules

- One message plays at a time, in arrival order. `attention` messages go before queued `summary` and `progress` messages.
- A new message from an agent removes the queued `progress` messages of that same agent.
- `interrupt: true` stops and clears the messages of the same agent only. It does not cut other agents.
- The agent name comes from the MCP client name (for example `claude-code`).

## Speech rules

The skill in [skill/breathing/SKILL.md](skill/breathing/SKILL.md) tells the agent:

- Speak at the end of a turn that did real work, at real milestones of long tasks, and when it is blocked or needs a decision.
- Speak only when it helps. Skip trivial replies.
- One or two sentences by default. Longer only when the user asks.
- Never speak code, paths, URLs or long lists. Point to the output instead.

The app also cleans the text before speech: it removes Markdown and code blocks, and it changes paths and links to "the file" and "the link".

## Controls

| Control | Action |
|---|---|
| Click the orb | Stop speaking |
| Drag the orb | Move it (the position is saved) |
| Right click the orb, or click the menu bar icon | Menu: mute, stop, voice, speed, volume, show orb, test sentence, install, start at login |
| `Control+Option+Command+S` | Stop speaking |
| `Control+Option+Command+M` | Mute or unmute |

Settings are in `~/Library/Application Support/Breathing/settings.json`. You can change the port and the hotkeys there.

## Test from the terminal

```bash
node scripts/say.mjs "Done. The tests pass. Have a look at the summary."
```

```bash
node scripts/say.mjs status
```

## Project layout

| Path | Content |
|---|---|
| `src/main/main.ts` | App start, menu bar, orb window, hotkeys |
| `src/main/tts-worker.ts` | Kokoro in a separate utility process |
| `src/main/queue.ts` | Speech queue |
| `src/main/text.ts` | Text cleanup and sentence split |
| `src/main/mcp-server.ts` | MCP server (Streamable HTTP, localhost only) |
| `src/main/installer.ts` | Setup for Claude Code and Codex |
| `src/bridge/bridge.ts` | stdio to HTTP bridge |
| `src/renderer/` | Orb and audio player |
| `skill/breathing/` | The skill for agents |

## Not in this version

Speech input, Windows and Linux builds, cloud TTS, languages other than English.
