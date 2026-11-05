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
  private idleTimer: NodeJS.Timeout | null = null;
  private expectedExit = false;
  private unloadAfterMs = 0;
  voices: Voice[] = [];
  ready = false;

  setUnloadAfter(minutes: number): void {
    this.unloadAfterMs = Math.max(0, minutes) * 60_000;
    this.scheduleUnload();
  }

  start(): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    this.expectedExit = false;
    this.progress.clear();
    this.emit("loading");
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
          this.scheduleUnload();
        } else if (message.type === "progress") {
          this.progress.set(message.file, { loaded: message.loaded, total: message.total });
          this.emit("progress", this.progressFraction());
        } else if (message.type === "audio") {
          const entry = this.pending.get(message.id);
          this.pending.delete(message.id);
          entry?.resolve({ pcm: message.pcm, sampleRate: message.sampleRate });
          this.scheduleUnload();
        } else if (message.type === "error") {
          if (message.id !== undefined) {
            const entry = this.pending.get(message.id);
            this.pending.delete(message.id);
            entry?.reject(new Error(message.message));
            this.scheduleUnload();
          } else {
            reject(new Error(message.message));
            child.kill();
          }
        }
      });
      child.on("exit", (code) => {
        const expected = this.expectedExit;
        this.expectedExit = false;
        this.clearIdleTimer();
        this.ready = false;
        this.readyPromise = null;
        this.child = null;
        for (const entry of this.pending.values()) entry.reject(new Error(`TTS process exited (${code})`));
        this.pending.clear();
        this.emit("exit", code, expected);
        if (expected) this.emit("sleep");
        reject(new Error(`TTS process exited (${code})`));
      });
      this.send({ type: "init", cacheDir: join(app.getPath("userData"), "models") });
    });
    return this.readyPromise;
  }

  async generate(text: string, voice: string, speed: number): Promise<AudioResult> {
    this.clearIdleTimer();
    await this.start();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ type: "generate", id, text, voice, speed });
    });
  }

  stop(): void {
    this.clearIdleTimer();
    if (!this.child) return;
    this.expectedExit = true;
    this.child.kill();
  }

  private scheduleUnload(): void {
    this.clearIdleTimer();
    if (this.unloadAfterMs <= 0 || !this.child || this.pending.size > 0) return;
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null;
      if (this.pending.size === 0) this.stop();
    }, this.unloadAfterMs);
  }

  private clearIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
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
