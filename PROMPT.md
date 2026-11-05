# Breathing — a voice for AI coding agents

## Goal

Build a macOS Electron app that gives a voice to AI coding agents (Claude Code, Codex, and other MCP clients).

The agent does its work as usual and writes its full answer as text. Before the final text answer, the agent calls the app through MCP and says a short, spoken message, like a coworker who sits next to the user:

> "I fixed the login bug and added two tests. Have a look at the auth service changes. One test is still flaky."

The voice does not read the output. It gives context and points the user to the output.

Ship two parts together:

1. **The app**: local text-to-speech (TTS), an MCP server, a menu bar icon, and a floating orb.
2. **The skill**: instructions that tell the agent that the voice exists and when and how to use it.

This is the **output** system only. Speech input (the user talks to the agent) is out of scope for this version. Do not block a later input system in the design.

## Decisions

| Topic | Decision |
|---|---|
| Platform | macOS first. Keep the code portable where it costs nothing. |
| Stack | Electron + TypeScript. |
| TTS engine | Kokoro-82M, run **locally** in the app with `kokoro-js` (ONNX). No network calls for speech. The Hugging Face Space `hexgrad/Kokoro-TTS` is only a reference demo. |
| Language | English only. Default voice `af_heart`. User can change voice and speed in settings. |
| MCP | Official `@modelcontextprotocol/sdk`. See "MCP server" below. |
| UI | Menu bar icon + a small floating orb. No main window. |
| When to speak | End of turn, progress on long tasks, and any moment the agent judges a spoken message is really useful. See "Speech rules". |

## The app

### TTS

- Load Kokoro on app start. Download the model on first run, cache it in the app data folder, and show progress in the menu bar.
- Split text into sentences. Generate and play sentence by sentence, so the first audio starts fast (target: under 1 s after the call on an Apple Silicon Mac).
- Clean the text before TTS: remove Markdown, code, URLs and file paths. Read common symbols and abbreviations in a natural way.
- Play audio with the Web Audio API in a hidden renderer, or a different method if it gives lower latency.

### Speech queue

- One global FIFO queue. Messages never overlap.
- Each message has a source (the client name, for example `claude-code`, `codex`) and optional a session label. The orb shows the source while it speaks.
- The `interrupt` flag stops the current message and clears the queue of that source.
- Drop a progress message if it is still in the queue when a newer message from the same source arrives.

### MCP server

Agents start MCP servers in different ways, but there must be only one app and one audio output. So:

- The app runs a **Streamable HTTP MCP server on `127.0.0.1`** (fixed default port, configurable).
- Also ship a small **stdio bridge** binary (`breathing-mcp`) for clients that only support stdio. It forwards calls to the running app. If the app does not run, the bridge starts it.
- Accept only local connections.

Tools:

| Tool | Input | Behaviour |
|---|---|---|
| `speak` | `text` (string), `kind` (`summary` \| `progress` \| `attention`), `interrupt` (bool, default false) | Puts the message in the queue and **returns immediately**. Does not wait for audio. Returns a message id. If the user muted the app, returns `muted: true` and does not speak. |
| `stop` | none | Stops current speech and clears the queue. |
| `status` | none | Returns `muted`, `speaking`, queue length, current voice. |

Write tool descriptions so that an agent that has not read the skill still uses `speak` correctly (short, no code, do not read the output).

### UI

**Menu bar icon**

- States: idle, speaking, muted, model loading, error.
- Menu: Mute / Unmute, Stop speaking, Voice (list of English Kokoro voices with a preview), Speed, Show orb (on/off), Start at login, Install skill and MCP config (see "Installation"), Quit.

**Floating orb**

- Small, round, always on top, draggable. It remembers its position.
- It "breathes" slowly when idle and animates with the audio level when it speaks.
- It shows the source name and the current sentence as a small caption while it speaks.
- Click: stop. Right click: the same menu as the menu bar.
- It must not take focus from the user's terminal or editor.

**Global hotkey**: one shortcut to stop speech, one to mute (configurable).

### Settings

Store voice, speed, volume, mute, orb visibility, orb position, port, and hotkeys. Use a local JSON file in the app data folder.

## The skill

Ship a skill in the format of each client (Claude Code: `~/.claude/skills/breathing/SKILL.md`; Codex: its current skill or `AGENTS.md` format — check the current docs). The skill content is the same for each client.

### Speech rules (the content of the skill)

**Role.** You are a coworker who sits next to the user. You do not read your output aloud. You tell the user what you did, what is important, and where to look.

**When to speak**

1. **End of turn.** Before your final text answer, on each turn that did real work, call `speak` with `kind: summary`.
2. **Progress.** On long tasks, speak at real milestones only (for example "Tests pass, now I update the docs"). Not more than one progress message every minute or two. Not on each tool call.
3. **Attention.** Speak with `kind: attention` when you are blocked, when you need a decision, or when you find something the user must know now (a risk, a failed step, a surprise).
4. **Only when it adds value.** Speak because the message helps the user, not because a rule allows it. Do not speak on short, trivial replies. If you have nothing useful to say, say nothing.

**How to speak**

- Default length: one or two sentences, about 30 words maximum.
- Speak longer only when the user asks for more detail, or asks you to explain by voice.
- Point to the output: "Have a look at the migration plan in the answer", "Check the diff in the payments module".
- Never read code, file paths, URLs, stack traces, tables, or long lists. Name them in plain words ("the config file", "the third test").
- Say the most important thing first. Say bad news clearly.
- Use plain, natural spoken English. No Markdown.
- Do not repeat the same message in speech and in text. The text has the detail. The voice has the context.

**Examples**

- Good: "Done. I refactored the cache layer and all tests pass. One thing to check: I changed the expiry default."
- Good: "I'm blocked. The build needs an API key I don't have. Tell me where to find it."
- Bad: reading the full answer, reading a code block, or "I have completed the task you asked for" with no content.

**If the tool fails or the app is muted**, continue with the text answer as usual. Never retry speech in a loop.

## Installation

From the menu bar, "Install skill and MCP config":

- Shows which clients it found (Claude Code, Codex).
- Shows the exact changes before it writes them, and asks for confirmation.
- Claude Code: adds the MCP server (for example with `claude mcp add`) and copies the skill.
- Codex: adds the server to the Codex config file and installs the skill.
- Also gives the manual steps in a README for other clients.

## Out of scope for this version

- Speech input / voice commands.
- Windows and Linux builds.
- Cloud TTS.
- Languages other than English.

## Done when

1. A fresh install downloads the model and speaks a test sentence from the menu bar.
2. Claude Code and Codex both connect to the app and call `speak`.
3. Two agents that speak at the same time are queued, not mixed.
4. First audio starts in under 1 s for a short sentence on Apple Silicon.
5. Stop, mute and the hotkeys work during speech.
6. With the skill installed, a real Claude Code session speaks a short summary at the end of a task and does not read the output.
7. A README explains install, the manual MCP setup, and the speech rules.
