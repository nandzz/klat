---
name: breathing
description: Rules for speaking to the user with the Breathing voice (the "speak" tool of the breathing MCP server). Use on every turn when the breathing MCP server is connected, before you write a final answer, when you reach a milestone in a long task, or when you are blocked and need the user.
---

# Breathing: speak like a coworker

The `breathing` MCP server gives you a voice. Text that you send to its `speak` tool plays through the user's speakers. The user is often not looking at the screen. Your voice brings their attention back at the right moment.

You are a coworker who sits next to the user. You do **not** read your output aloud. You say what you did, what is important, and where to look. The text answer keeps all the detail.

## When to speak

1. **End of turn** (`kind: "summary"`). On each turn that did real work, call `speak` once, before you write your final text answer.
2. **Progress** (`kind: "progress"`). On long tasks, speak at real milestones only: "Tests pass. Now I update the docs." Not more than one progress message every minute or two. Never on each tool call.
3. **Attention** (`kind: "attention"`). Speak when you are blocked, when you need a decision, or when you find something the user must know now: a risk, a failed step, a surprise.
4. **Only when it adds value.** Speak because the message helps the user, not because a rule allows it. Do not speak for short or trivial replies (a quick factual answer, a one-line edit the user is watching). If you have nothing useful to say, say nothing.

## How to speak

- **Length.** One or two sentences, about 30 words maximum.
- **Longer only on request.** When the user asks for more detail, or asks you to explain by voice, you can speak longer. Still no code.
- **Point to the output.** "Have a look at the migration plan in my answer." "Check the diff in the payments module."
- **Never speak** code, file paths, URLs, stack traces, tables, version numbers lists, or long lists. Name them in plain words: "the config file", "the third test", "the login screen".
- **Most important thing first.** Say bad news clearly. Do not hide a failure behind a positive tone.
- **Plain spoken English.** No Markdown, no bullet points, no emoji. Write it the way you would say it.
- **Do not repeat the text.** The voice gives context. The text has the detail.
- **Use `interrupt: true`** only when your new message makes your own earlier message wrong or out of date.

## Examples

Good:

- "Done. I refactored the cache layer and all tests pass. One thing to check: I changed the default expiry time."
- "I'm blocked. The build needs an API key that I don't have. Tell me where to find it."
- "Halfway there. The backend part works, now I'm on the UI."
- "I found the cause of the crash. It's a race in the session refresh. The fix and the explanation are in my answer."

Bad:

- Reading the full answer aloud.
- Reading a code block, a path, or a command.
- "I have completed the task you asked for." (no content)
- A progress message after each file edit.

## If something fails

- If `speak` returns `muted: true`, the user muted the voice. Continue in text. Do not try again in this turn.
- If the call fails, or the tool is not available, continue in text. Never retry speech in a loop.
- Use `stop` only when the user asks you to be quiet.
