# Klat

Klat gives a voice to AI coding agents. It is a macOS menu bar app. Agents such as Claude Code and Codex connect to it through MCP. When an agent finishes work, it says a short message, like a coworker: what it did, what is important, and where to look. The voice does not read the output.

- Speech runs locally with [Kokoro-82M](https://huggingface.co/hexgrad/Kokoro-82M) (`kokoro-js`, ONNX). No cloud and no API key.
- One app serves all agents. Messages go into one queue, so voices never overlap.
- A floating orb breathes while idle and moves with the voice while it speaks. It shows who speaks and the current sentence.

## Install

```bash
brew install --cask nandzz/tap/klat
```

Open Klat from Applications. Then click the menu bar icon and choose **Install for Claude Code and Codex…** (see [Connect your agents](#connect-your-agents)).

The app is signed with a Developer ID certificate and notarized by Apple.

## Requirements

- macOS 14 or later on Apple Silicon.
- About 100 MB of disk for the voice model. The app downloads it on the first start.
- Node.js 20 or later, only to build from source.

## Build and run

```bash
npm install
```

```bash
npm start
```

The first start downloads the model to `~/Library/Application Support/Klat/models`. The orb shows a progress ring. When the ring is full, the voice is ready.

To make a signed `.app` bundle in `dist-app/`:

```bash
npm run dist
```

### Release

The release script runs the tests, builds the app, signs it with the Developer ID certificate, notarizes and staples it, and checks it with Gatekeeper. It needs a notarytool keychain profile:

```bash
xcrun notarytool store-credentials klat-notary --apple-id <apple-id> --team-id JM3HAUX538
```

Build and check only:

```bash
npm run release
```

Build, tag, and publish the GitHub release:

```bash
npm run release -- --publish
```

The script prints the SHA-256 of the zip. Put the version and the SHA-256 in `Casks/klat.rb` of [nandzz/homebrew-tap](https://github.com/nandzz/homebrew-tap).

## Connect your agents

### Automatic

Open the menu bar icon and click **Install for Claude Code and Codex…**. The app shows the exact changes and asks before it writes them:

- **Claude Code**: `claude mcp add --scope user klat` with the stdio bridge (see below), and the skill in `~/.claude/skills/klat/`.
- **Codex**: a `[mcp_servers.klat]` block in `~/.codex/config.toml` that starts the stdio bridge, and the skill in `~/.codex/skills/klat/`.

Start a new agent session after the install.

### Manual

Use the stdio bridge. The client starts the bridge when a session starts. The bridge starts the app if it does not run, and it connects again if the app restarts. So a session never loses the voice because the app was closed when the session started.

```json
{
  "command": "/Applications/Klat.app/Contents/MacOS/Klat",
  "args": ["/Applications/Klat.app/Contents/Resources/app.asar/dist/bridge/bridge.js"],
  "env": { "ELECTRON_RUN_AS_NODE": "1" }
}
```

For Claude Code:

```bash
claude mcp add --scope user klat -e ELECTRON_RUN_AS_NODE=1 -- /Applications/Klat.app/Contents/MacOS/Klat /Applications/Klat.app/Contents/Resources/app.asar/dist/bridge/bridge.js
```

Copy `skill/klat/SKILL.md` to the skills folder of your client.

The app also runs an MCP server with Streamable HTTP on `http://127.0.0.1:48613/mcp`. You can use it directly, but a client that connects over HTTP keeps the server as failed for the whole session if the app is not running when the session starts. MCP servers load only when a session starts, so sessions that were open before the install do not have the voice.

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

The skill in [skill/klat/SKILL.md](skill/klat/SKILL.md) tells the agent:

- Speak before every final answer that has content, also read-only answers such as a status report. Skip only one-line replies.
- Speak at real milestones of long tasks, and when it is blocked or needs a decision.
- Load the tool first when the client lists it as deferred.
- One or two sentences by default. Longer only when the user asks.
- Never speak code, paths, URLs or long lists. Point to the output instead.

The app also cleans the text before speech: it removes Markdown and code blocks, and it changes paths and links to "the file" and "the link".

## Controls

| Control | Action |
|---|---|
| Click the orb | Small menu: repeat last sentence, repeat last message, stop speaking, mute |
| Drag the orb | Move it (the position is saved) |
| Right click the orb, or click the menu bar icon | Full menu: mute, stop, repeat last sentence, voice, speed, volume, show orb, test sentence, install, start at login |
| `Control+Option+Command+S` | Stop speaking |
| `Control+Option+Command+M` | Mute or unmute |

Settings are in `~/Library/Application Support/Klat/settings.json`. You can change the port and the hotkeys there.

## Resource use

Measured on an Apple Silicon Mac with the packaged app:

| State | CPU | Memory |
|---|---|---|
| Idle, voice model loaded | about 0.3% | about 940 MB |
| Idle, voice model unloaded | about 0.1% | about 510 MB |

- The voice model uses about 450 MB while it is loaded. **Free memory when idle** in the menu unloads it after 5, 10 (default) or 30 minutes without speech. The next message loads it again, which adds about 3 seconds before the first sound.
- The orb stops its breathing animation 20 seconds after it stops speaking. It starts again when it speaks, when the model loads, or when you point at it.
- The audio output is released 3 seconds after the last sentence.
- Speech generation uses the CPU for a short time per sentence, about one third of the sentence duration.

## Tests

```bash
npm test
```

The unit tests use Vitest. They cover the text cleanup, the speech queue (order, drop rules, interrupt, stop, repeat), the MCP server (tools, client names, mute, Host and Origin checks), and the Codex config writer.

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
| `src/main/toml.ts` | Codex config writer |
| `src/bridge/bridge.ts` | stdio to HTTP bridge |
| `src/renderer/` | Orb and audio player |
| `skill/klat/` | The skill for agents |
| `scripts/release.sh` | Signed and notarized release build |
| `test/` | Unit tests |

## Not in this version

Speech input, Windows and Linux builds, cloud TTS, languages other than English.
