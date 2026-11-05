import { app, utilityProcess, type UtilityProcess } from "electron";
import { EventEmitter } from "node:events";
import { join } from "node:path";
import type { WorkerRequest, WorkerResponse } from "../shared/tts-protocol.js";

export interface Voice {
  id: string;
  name: string;
  gender: string;
  language: string;
  grade: string;
}

export interface AudioResult {
  pcm: Float32Array;
  sampleRate: number;
}

type Pending = { resolve: (audio: AudioResult) => void; reject: (error: Error) => void };

export class TtsEngine extends EventEmitter {
  private child: UtilityProcess | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private readyPromise: Promise<void> | null = null;
  private progress = new Map<string, { loaded: number; total: number }>();
  voices: Voice[] = [];
  ready = false;

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise((resolve, reject) => {
      const child = utilityProcess.fork(join(import.meta.dirname, "tts-worker.js"), [], {
        serviceName: "Breathing TTS",
        stdio: "inherit",
      });
      this.child = child;
      child.on("message", (message: WorkerResponse) => {
        if (message.type === "ready") {
          this.voices = Object.entries(message.voices).map(([id, v]) => ({
            id,
            name: v.name,
            gender: v.gender,
            language: v.language,
            grade: v.overallGrade,
          }));
          this.ready = true;
          this.emit("ready");
          resolve();
        } else if (message.type === "progress") {
          this.progress.set(message.file, { loaded: message.loaded, total: message.total });
          this.emit("progress", this.progressFraction());
        } else if (message.type === "audio") {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          entry?.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
        } else if (message.type === "error") {
          if (message.id !== undefined) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            entry?.reject(new Error(message.message));
          } else {
            reject(new Error(message.message));
            child.kill();
          }
        }
      });
      child.on("exit", (code) => {
        this.ready = false;
        this.readyPromise = null;
        this.child = null;
        for (const entry of this.pending.values()) entry.reject(new Error(`TTS process exited (${code})`));
        this.pending.clear();
        this.emit("exit", code);
        reject(new Error(`TTS process exited (${code})`));
      });
      this.send({ type: "init", cacheDir: join(app.getPath("userData"), "models") });
    });
    return this.readyPromise;
  }

  async generate(text: string, voice: string, speed: number): Promise<AudioResult> {
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "generate", id, text, voice, speed });
    });
  }

  stop(): void {
    this.child?.kill();
  }

  private progressFraction(): number {
    let loaded = 0;
    let total = 0;
    for (const entry of this.progress.values()) {
      loaded += entry.loaded;
      total += entry.total;
    }
    return total > 0 ? loaded / total : 0;
  }

  private send(message: WorkerRequest): void {
    this.child?.postMessage(message);
  }
}
