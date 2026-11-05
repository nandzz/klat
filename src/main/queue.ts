import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import type { DropFilter, PlayerEvent, SpeechChunk, SpeechKind } from "../shared/types.js";
import { cleanForSpeech, splitSentences } from "./text.js";
import type { TtsEngine } from "./tts.js";

const HISTORY_SIZE = 20;

export interface Player {
  enqueue(chunk: SpeechChunk): void;
  drop(filter: DropFilter): void;
}

export interface SpeakRequest {
  text: string;
  kind: SpeechKind;
  source: string;
  interrupt: boolean;
}

interface Message {
  id: string;
  source: string;
  kind: SpeechKind;
  sentences: string[];
}

interface Active {
  message: Message;
  cancelled: boolean;
}

export class SpeechQueue extends EventEmitter {
  private pending: Message[] = [];
  private active: Active | null = null;
  private playerQueued = 0;
  private playing: { messageId: string; source: string; text: string } | null = null;
  private lastSpoken: { messageId: string; source: string; text: string } | null = null;
  private history = new Map<string, Message>();

  constructor(
    private tts: TtsEngine,
    private player: Player,
    private voice: () => { voice: string; speed: number },
  ) {
    super();
  }

  speak(request: SpeakRequest): { id: string; spokenText: string } | null {
    const cleaned = cleanForSpeech(request.text);
    const sentences = splitSentences(cleaned);
    if (sentences.length === 0) return null;

    if (request.interrupt) {
      this.dropSource(request.source);
    } else {
      this.pending = this.pending.filter((m) => !(m.source === request.source && m.kind === "progress"));
      this.player.drop({ source: request.source, kind: "progress", includePlaying: false });
    }

    const message: Message = { id: randomUUID(), source: request.source, kind: request.kind, sentences };
    if (request.kind === "attention") {
      const index = this.pending.findIndex((m) => m.kind !== "attention");
      if (index === -1) this.pending.push(message);
      else this.pending.splice(index, 0, message);
    } else {
      this.pending.push(message);
    }
    void this.pump();
    this.emitState();
    return { id: message.id, spokenText: sentences.join(" ") };
  }

  canRepeat(): { sentence: boolean; message: boolean } {
    const message = this.lastSpoken ? this.history.get(this.lastSpoken.messageId) : undefined;
    return { sentence: this.lastSpoken !== null, message: (message?.sentences.length ?? 0) > 1 };
  }

  repeatLastSentence(): boolean {
    if (!this.lastSpoken) return false;
    const original = this.history.get(this.lastSpoken.messageId);
    this.replay(this.lastSpoken.source, original?.kind ?? "summary", [this.lastSpoken.text]);
    return true;
  }

  repeatLastMessage(): boolean {
    const original = this.lastSpoken ? this.history.get(this.lastSpoken.messageId) : undefined;
    if (!original) return false;
    this.replay(original.source, original.kind, original.sentences);
    return true;
  }

  private replay(source: string, kind: SpeechKind, sentences: string[]): void {
    this.pending.unshift({ id: randomUUID(), source, kind, sentences: [...sentences] });
    void this.pump();
    this.emitState();
  }

  private remember(message: Message): void {
    this.history.set(message.id, message);
    while (this.history.size > HISTORY_SIZE) this.history.delete(this.history.keys().next().value!);
  }

  stopAll(): void {
    this.pending = [];
    if (this.active) this.active.cancelled = true;
    this.player.drop({ includePlaying: true });
    this.emitState();
  }

  dropSource(source: string): void {
    this.pending = this.pending.filter((m) => m.source !== source);
    if (this.active?.message.source === source) this.active.cancelled = true;
    this.player.drop({ source, includePlaying: true });
  }

  onPlayerEvent(event: PlayerEvent): void {
    if (event.type === "chunk-start") {
      this.playing = { messageId: event.messageId, source: event.source, text: event.text };
      this.lastSpoken = this.playing;
      this.emit("caption", this.playing);
    } else if (event.type === "idle") {
      this.playing = null;
    } else if (event.type === "queue-size") {
      this.playerQueued = event.size;
    }
    this.emitState();
  }

  status(): { speaking: boolean; queued: number; current: { source: string; text: string } | null } {
    return {
      speaking: this.playing !== null || this.active !== null,
      queued: this.pending.length + this.playerQueued,
      current: this.playing ? { source: this.playing.source, text: this.playing.text } : null,
    };
  }

  private async pump(): Promise<void> {
    if (this.active) return;
    const message = this.pending.shift();
    if (!message) return;
    this.remember(message);
    const active: Active = { message, cancelled: false };
    this.active = active;
    this.emitState();
    try {
      for (let i = 0; i < message.sentences.length; i++) {
        if (active.cancelled) break;
        const { voice, speed } = this.voice();
        const audio = await this.tts.generate(message.sentences[i]!, voice, speed);
        if (active.cancelled) break;
        this.player.enqueue({
          messageId: message.id,
          source: message.source,
          kind: message.kind,
          text: message.sentences[i]!,
          pcm: audio.pcm,
          sampleRate: audio.sampleRate,
          last: i === message.sentences.length - 1,
        });
      }
    } catch (error) {
      this.emit("error", error);
    } finally {
      this.active = null;
      this.emitState();
      void this.pump();
    }
  }

  private emitState(): void {
    this.emit("state", this.status());
  }
}
