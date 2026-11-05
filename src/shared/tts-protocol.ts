export type WorkerRequest =
  | { type: "init"; cacheDir: string }
  | { type: "generate"; id: number; text: string; voice: string; speed: number };

export type WorkerResponse =
  | { type: "progress"; file: string; loaded: number; total: number }
  | { type: "ready"; voices: Record<string, { name: string; gender: string; language: string; overallGrade: string }> }
  | { type: "audio"; id: number; pcm: Float32Array; sampleRate: number }
  | { type: "error"; id?: number; message: string };
