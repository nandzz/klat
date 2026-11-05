import { env } from "@huggingface/transformers";
import { KokoroTTS } from "kokoro-js";
import type { WorkerRequest, WorkerResponse } from "../shared/tts-protocol.js";

interface ParentPort {
  on(event: "message", listener: (event: { data: WorkerRequest }) => void): void;
  postMessage(message: WorkerResponse): void;
}

const port = (process as unknown as { parentPort: ParentPort }).parentPort;
const MODEL_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";

let tts: KokoroTTS | null = null;
let chain: Promise<void> = Promise.resolve();

function send(message: WorkerResponse): void {
  port.postMessage(message);
}

async function init(cacheDir: string): Promise<void> {
  env.cacheDir = cacheDir;
  env.allowLocalModels = false;
  tts = await KokoroTTS.from_pretrained(MODEL_ID, {
    dtype: "q8",
    device: "cpu",
    progress_callback: (info) => {
      if (info.status === "progress") {
        send({ type: "progress", file: info.file, loaded: info.loaded, total: info.total });
      }
    },
  });
  await tts.generate("Ready.", { voice: "af_heart" });
  send({ type: "ready", voices: tts.voices });
}

async function generate(id: number, text: string, voice: string, speed: number): Promise<void> {
  if (!tts) {
    send({ type: "error", id, message: "Model is not loaded" });
    return;
  }
  const audio = await tts.generate(text, { voice: voice as keyof typeof tts.voices, speed });
  send({ type: "audio", id, pcm: audio.audio, sampleRate: audio.sampling_rate });
}

port.on("message", ({ data }) => {
  chain = chain.then(async () => {
    try {
      if (data.type === "init") await init(data.cacheDir);
      else if (data.type === "generate") await generate(data.id, data.text, data.voice, data.speed);
    } catch (error) {
      send({
        type: "error",
        id: data.type === "generate" ? data.id : undefined,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });
});
