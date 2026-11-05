import { beforeEach, describe, expect, it, vi } from "vitest";
import { SpeechQueue, type Player } from "../src/main/queue.js";
import type { TtsEngine } from "../src/main/tts.js";
import type { DropFilter, SpeechChunk } from "../src/shared/types.js";

interface Call {
  text: string;
  voice: string;
  speed: number;
  resolve: () => void;
  reject: (error: Error) => void;
}

class FakeTts {
  calls: Call[] = [];
  auto = true;

  generate(text: string, voice: string, speed: number): Promise<{ pcm: Float32Array; sampleRate: number }> {
    return new Promise((resolve, reject) => {
      const call: Call = {
        text,
        voice,
        speed,
        resolve: () => resolve({ pcm: new Float32Array([0.1, 0.2]), sampleRate: 24000 }),
        reject,
      };
      this.calls.push(call);
      if (this.auto) call.resolve();
    });
  }

  texts(): string[] {
    return this.calls.map((c) => c.text);
  }
}

class FakePlayer implements Player {
  chunks: SpeechChunk[] = [];
  drops: DropFilter[] = [];

  enqueue(chunk: SpeechChunk): void {
    this.chunks.push(chunk);
  }

  drop(filter: DropFilter): void {
    this.drops.push(filter);
  }

  texts(): string[] {
    return this.chunks.map((c) => c.text);
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setImmediate(resolve));
};

let tts: FakeTts;
let player: FakePlayer;
let voice: { voice: string; speed: number };
let queue: SpeechQueue;

beforeEach(() => {
  tts = new FakeTts();
  player = new FakePlayer();
  voice = { voice: "af_heart", speed: 1 };
  queue = new SpeechQueue(tts as unknown as TtsEngine, player, () => voice);
});

describe("speak", () => {
  it("returns null and queues nothing when only code is left", async () => {
    expect(queue.speak({ text: "```\nconst a = 1;\n```", kind: "summary", source: "a", interrupt: false })).toBeNull();
    await flush();
    expect(tts.calls).toHaveLength(0);
    expect(queue.status().queued).toBe(0);
  });

  it("returns an id and the cleaned spoken text", () => {
    const result = queue.speak({ text: "Done. Check **src/main/a.ts** now.", kind: "summary", source: "a", interrupt: false });
    expect(result?.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result?.spokenText).toBe("Done. Check the file now.");
  });

  it("generates each sentence in order and marks only the last chunk", async () => {
    queue.speak({ text: "Done. I fixed the login bug. All tests pass now.", kind: "summary", source: "claude-code", interrupt: false });
    await flush();
    expect(player.texts()).toEqual(["Done.", "I fixed the login bug.", "All tests pass now."]);
    expect(player.chunks.map((c) => c.last)).toEqual([false, false, true]);
    expect(new Set(player.chunks.map((c) => c.messageId)).size).toBe(1);
    expect(player.chunks.every((c) => c.source === "claude-code" && c.kind === "summary")).toBe(true);
    expect(player.chunks[0]?.sampleRate).toBe(24000);
  });

  it("uses the current voice and speed for each sentence", async () => {
    tts.auto = false;
    queue.speak({ text: "The first one here. The second one here.", kind: "summary", source: "a", interrupt: false });
    await flush();
    voice = { voice: "bm_george", speed: 1.2 };
    tts.calls[0]!.resolve();
    await flush();
    expect(tts.calls.map((c) => [c.voice, c.speed])).toEqual([
      ["af_heart", 1],
      ["bm_george", 1.2],
    ]);
  });

  it("generates one message at a time, in arrival order", async () => {
    tts.auto = false;
    queue.speak({ text: "Message from agent one.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Message from agent two.", kind: "summary", source: "b", interrupt: false });
    await flush();
    expect(tts.texts()).toEqual(["Message from agent one."]);
    tts.calls[0]!.resolve();
    await flush();
    expect(tts.texts()).toEqual(["Message from agent one.", "Message from agent two."]);
    tts.calls[1]!.resolve();
    await flush();
    expect(player.chunks.map((c) => c.source)).toEqual(["a", "b"]);
  });
});

describe("queue rules", () => {
  it("drops queued progress messages of the same source when a new message comes", async () => {
    tts.auto = false;
    queue.speak({ text: "Agent b is busy talking.", kind: "summary", source: "b", interrupt: false });
    queue.speak({ text: "Old progress from a.", kind: "progress", source: "a", interrupt: false });
    queue.speak({ text: "Final summary from a.", kind: "summary", source: "a", interrupt: false });
    expect(player.drops).toContainEqual({ source: "a", kind: "progress", includePlaying: false });
    tts.auto = true;
    tts.calls[0]!.resolve();
    await flush();
    expect(player.texts()).toEqual(["Agent b is busy talking.", "Final summary from a."]);
  });

  it("keeps queued progress messages of other sources", async () => {
    tts.auto = false;
    queue.speak({ text: "Agent c is busy talking.", kind: "summary", source: "c", interrupt: false });
    queue.speak({ text: "Progress from agent b.", kind: "progress", source: "b", interrupt: false });
    queue.speak({ text: "Summary from agent a.", kind: "summary", source: "a", interrupt: false });
    tts.auto = true;
    tts.calls[0]!.resolve();
    await flush();
    expect(player.texts()).toEqual(["Agent c is busy talking.", "Progress from agent b.", "Summary from agent a."]);
  });

  it("puts attention messages before queued normal messages, after other attention messages", async () => {
    tts.auto = false;
    queue.speak({ text: "Busy message plays now.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Normal summary queued.", kind: "summary", source: "b", interrupt: false });
    queue.speak({ text: "First attention message.", kind: "attention", source: "c", interrupt: false });
    queue.speak({ text: "Second attention message.", kind: "attention", source: "d", interrupt: false });
    tts.auto = true;
    tts.calls[0]!.resolve();
    await flush();
    expect(player.texts()).toEqual([
      "Busy message plays now.",
      "First attention message.",
      "Second attention message.",
      "Normal summary queued.",
    ]);
  });

  it("interrupt clears queued and active messages of the same source only", async () => {
    tts.auto = false;
    queue.speak({ text: "Long message from a. It has a second sentence.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Another message from a.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Message from agent b.", kind: "summary", source: "b", interrupt: false });
    await flush();
    queue.speak({ text: "Urgent message from a.", kind: "attention", source: "a", interrupt: true });
    expect(player.drops).toContainEqual({ source: "a", includePlaying: true });
    tts.auto = true;
    tts.calls[0]!.resolve();
    await flush();
    expect(player.texts()).toEqual(["Urgent message from a.", "Message from agent b."]);
  });

  it("interrupt does not cancel the active message of another source", async () => {
    tts.auto = false;
    queue.speak({ text: "Agent b speaks first. And a second sentence.", kind: "summary", source: "b", interrupt: false });
    await flush();
    queue.speak({ text: "Agent a interrupts itself.", kind: "summary", source: "a", interrupt: true });
    tts.auto = true;
    tts.calls[0]!.resolve();
    await flush();
    expect(player.texts()).toEqual(["Agent b speaks first.", "And a second sentence.", "Agent a interrupts itself."]);
    expect(player.drops).toContainEqual({ source: "a", includePlaying: true });
  });

  it("stopAll clears everything and stops the player", async () => {
    tts.auto = false;
    queue.speak({ text: "First message here. With more text.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Second message here.", kind: "summary", source: "b", interrupt: false });
    await flush();
    queue.stopAll();
    expect(player.drops).toContainEqual({ includePlaying: true });
    tts.calls[0]!.resolve();
    await flush();
    expect(player.chunks).toHaveLength(0);
    expect(tts.calls).toHaveLength(1);
    expect(queue.status()).toMatchObject({ speaking: false, queued: 0 });
  });

  it("continues with the next message when generation fails", async () => {
    tts.auto = false;
    const errors: unknown[] = [];
    queue.on("error", (error) => errors.push(error));
    queue.speak({ text: "This one will fail.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "This one will work.", kind: "summary", source: "b", interrupt: false });
    await flush();
    tts.calls[0]!.reject(new Error("model crashed"));
    await flush();
    tts.calls[1]!.resolve();
    await flush();
    expect(errors).toHaveLength(1);
    expect(player.texts()).toEqual(["This one will work."]);
  });
});

describe("status", () => {
  it("is idle with nothing queued", () => {
    expect(queue.status()).toEqual({ speaking: false, queued: 0, current: null });
  });

  it("counts pending messages and player chunks", async () => {
    tts.auto = false;
    queue.speak({ text: "Active message here.", kind: "summary", source: "a", interrupt: false });
    queue.speak({ text: "Pending message here.", kind: "summary", source: "b", interrupt: false });
    await flush();
    queue.onPlayerEvent({ type: "queue-size", size: 3 });
    expect(queue.status()).toMatchObject({ speaking: true, queued: 4 });
  });

  it("follows player events for the current sentence", () => {
    const captions = vi.fn();
    queue.on("caption", captions);
    queue.onPlayerEvent({ type: "chunk-start", messageId: "m1", source: "codex", text: "Hello there." });
    expect(queue.status()).toEqual({ speaking: true, queued: 0, current: { source: "codex", text: "Hello there." } });
    expect(captions).toHaveBeenCalledWith({ messageId: "m1", source: "codex", text: "Hello there." });
    queue.onPlayerEvent({ type: "idle" });
    expect(queue.status()).toEqual({ speaking: false, queued: 0, current: null });
  });

  it("emits state changes", () => {
    const states = vi.fn();
    queue.on("state", states);
    queue.speak({ text: "Some message here.", kind: "summary", source: "a", interrupt: false });
    expect(states).toHaveBeenCalled();
  });
});

describe("repeat", () => {
  const playAll = () => {
    for (const chunk of player.chunks) {
      queue.onPlayerEvent({ type: "chunk-start", messageId: chunk.messageId, source: chunk.source, text: chunk.text });
    }
    queue.onPlayerEvent({ type: "idle" });
  };

  it("has nothing to repeat before anything played", () => {
    expect(queue.canRepeat()).toEqual({ sentence: false, message: false });
    expect(queue.repeatLastSentence()).toBe(false);
    expect(queue.repeatLastMessage()).toBe(false);
  });

  it("repeats the last sentence that played, with the same source and kind", async () => {
    queue.speak({ text: "Done. I fixed the login bug. All tests pass now.", kind: "attention", source: "codex", interrupt: false });
    await flush();
    playAll();
    player.chunks = [];
    expect(queue.canRepeat()).toEqual({ sentence: true, message: true });
    expect(queue.repeatLastSentence()).toBe(true);
    await flush();
    expect(player.texts()).toEqual(["All tests pass now."]);
    expect(player.chunks[0]).toMatchObject({ source: "codex", kind: "attention", last: true });
  });

  it("repeats the sentence that played last, not the last one generated", async () => {
    queue.speak({ text: "The first sentence here. The second sentence here.", kind: "summary", source: "a", interrupt: false });
    await flush();
    const first = player.chunks[0]!;
    queue.onPlayerEvent({ type: "chunk-start", messageId: first.messageId, source: first.source, text: first.text });
    player.chunks = [];
    queue.repeatLastSentence();
    await flush();
    expect(player.texts()).toEqual(["The first sentence here."]);
  });

  it("repeats the whole last message", async () => {
    queue.speak({ text: "Done. I fixed the login bug. All tests pass now.", kind: "summary", source: "a", interrupt: false });
    await flush();
    playAll();
    player.chunks = [];
    expect(queue.repeatLastMessage()).toBe(true);
    await flush();
    expect(player.texts()).toEqual(["Done.", "I fixed the login bug.", "All tests pass now."]);
    expect(player.chunks.map((c) => c.last)).toEqual([false, false, true]);
  });

  it("offers message repeat only for messages with more than one sentence", async () => {
    queue.speak({ text: "Only one sentence here.", kind: "summary", source: "a", interrupt: false });
    await flush();
    playAll();
    expect(queue.canRepeat()).toEqual({ sentence: true, message: false });
  });

  it("plays a repeat before other queued messages", async () => {
    queue.speak({ text: "Message to repeat later.", kind: "summary", source: "a", interrupt: false });
    await flush();
    playAll();
    tts.auto = false;
    queue.speak({ text: "Busy message plays now.", kind: "summary", source: "b", interrupt: false });
    queue.speak({ text: "Queued message waits.", kind: "summary", source: "c", interrupt: false });
    queue.repeatLastSentence();
    tts.auto = true;
    player.chunks = [];
    tts.calls.at(-1)!.resolve();
    await flush();
    expect(player.texts()).toEqual(["Busy message plays now.", "Message to repeat later.", "Queued message waits."]);
  });

  it("does not drop queued progress messages of the same source", async () => {
    queue.speak({ text: "Message to repeat later.", kind: "summary", source: "a", interrupt: false });
    await flush();
    playAll();
    player.drops = [];
    queue.repeatLastSentence();
    expect(player.drops).toEqual([]);
  });

  it("forgets old messages after 20 newer ones", async () => {
    queue.speak({ text: "The very first message. With two sentences.", kind: "summary", source: "a", interrupt: false });
    await flush();
    const first = player.chunks[0]!;
    for (let i = 0; i < 20; i++) queue.speak({ text: `Filler message number ${i}.`, kind: "summary", source: `s${i}`, interrupt: false });
    await flush();
    queue.onPlayerEvent({ type: "chunk-start", messageId: first.messageId, source: first.source, text: first.text });
    expect(queue.canRepeat()).toEqual({ sentence: true, message: false });
    expect(queue.repeatLastMessage()).toBe(false);
    expect(queue.repeatLastSentence()).toBe(true);
  });
});
