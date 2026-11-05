export type SpeechKind = "summary" | "progress" | "attention";

export interface SpeechChunk {
  messageId: string;
  source: string;
  kind: SpeechKind;
  text: string;
  pcm: Float32Array;
  sampleRate: number;
  last: boolean;
}

export interface DropFilter {
  source?: string;
  kind?: SpeechKind;
  includePlaying: boolean;
}

export type PlayerEvent =
  | { type: "chunk-start"; messageId: string; source: string; text: string }
  | { type: "message-end"; messageId: string }
  | { type: "idle" }
  | { type: "queue-size"; size: number };

export interface OrbState {
  status: "idle" | "speaking" | "muted" | "loading" | "error";
  detail?: string;
}
