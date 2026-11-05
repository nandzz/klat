import type { DropFilter, OrbState, PlayerEvent, SpeechChunk } from "../shared/types.js";

interface BreathingApi {
  onEnqueue(cb: (chunk: SpeechChunk) => void): void;
  onDrop(cb: (filter: DropFilter) => void): void;
  onVolume(cb: (volume: number) => void): void;
  onState(cb: (state: OrbState & { progress?: number }) => void): void;
  playerEvent(event: PlayerEvent): void;
  click(): void;
  contextMenu(): void;
  hover(inside: boolean): void;
  dragBy(dx: number, dy: number): void;
  dragEnd(): void;
  ready(): void;
}

const api = (window as unknown as { breathing: BreathingApi }).breathing;
const orb = document.getElementById("orb")!;
const caption = document.getElementById("caption")!;
const captionSource = document.getElementById("caption-source")!;
const captionText = document.getElementById("caption-text")!;
const root = document.documentElement;

const SENTENCE_GAP_MS = 90;

const ctx = new AudioContext({ latencyHint: "interactive" });
const gain = ctx.createGain();
const analyser = ctx.createAnalyser();
analyser.fftSize = 1024;
gain.connect(analyser);
analyser.connect(ctx.destination);

let queue: SpeechChunk[] = [];
let current: { chunk: SpeechChunk; node: AudioBufferSourceNode } | null = null;
let gapTimer: number | null = null;
let baseStatus: OrbState["status"] = "loading";

function reportQueue(): void {
  api.playerEvent({ type: "queue-size", size: queue.length });
}

function matches(chunk: SpeechChunk, filter: DropFilter): boolean {
  if (filter.source !== undefined && chunk.source !== filter.source) return false;
  if (filter.kind !== undefined && chunk.kind !== filter.kind) return false;
  return true;
}

function playNext(): void {
  if (current || gapTimer !== null) return;
  const chunk = queue.shift();
  reportQueue();
  if (!chunk) {
    setSpeaking(false);
    api.playerEvent({ type: "idle" });
    return;
  }
  if (ctx.state === "suspended") void ctx.resume();
  const buffer = ctx.createBuffer(1, chunk.pcm.length, chunk.sampleRate);
  buffer.copyToChannel(new Float32Array(chunk.pcm), 0);
  const node = ctx.createBufferSource();
  node.buffer = buffer;
  node.connect(gain);
  node.onended = () => {
    if (current?.node !== node) return;
    current = null;
    if (chunk.last) api.playerEvent({ type: "message-end", messageId: chunk.messageId });
    gapTimer = window.setTimeout(() => {
      gapTimer = null;
      playNext();
    }, SENTENCE_GAP_MS);
  };
  current = { chunk, node };
  setSpeaking(true);
  showCaption(chunk.source, chunk.text);
  api.playerEvent({ type: "chunk-start", messageId: chunk.messageId, source: chunk.source, text: chunk.text });
  node.start();
}

function drop(filter: DropFilter): void {
  const before = queue.length;
  queue = queue.filter((chunk) => !matches(chunk, filter));
  if (filter.includePlaying && current && matches(current.chunk, filter)) {
    const { node, chunk } = current;
    current = null;
    node.onended = null;
    node.stop();
    queue = queue.filter((c) => c.messageId !== chunk.messageId);
    api.playerEvent({ type: "message-end", messageId: chunk.messageId });
    playNext();
  } else if (queue.length !== before) {
    reportQueue();
  }
}

function setSpeaking(speaking: boolean): void {
  orb.dataset.status = speaking && baseStatus !== "muted" ? "speaking" : baseStatus;
  if (!speaking) hideCaption();
}

function showCaption(source: string, text: string): void {
  captionSource.textContent = source;
  captionText.textContent = text;
  caption.classList.add("visible");
}

function hideCaption(): void {
  caption.classList.remove("visible");
}

const levels = new Float32Array(analyser.fftSize);
let smoothed = 0;
function animate(): void {
  if (current) {
    analyser.getFloatTimeDomainData(levels);
    let sum = 0;
    for (const v of levels) sum += v * v;
    const rms = Math.sqrt(sum / levels.length);
    const target = Math.min(1, rms * 5.5);
    smoothed += (target - smoothed) * (target > smoothed ? 0.55 : 0.18);
  } else {
    smoothed *= 0.85;
  }
  root.style.setProperty("--level", smoothed.toFixed(3));
  requestAnimationFrame(animate);
}
requestAnimationFrame(animate);

api.onEnqueue((chunk) => {
  queue.push(chunk);
  reportQueue();
  playNext();
});
api.onDrop(drop);
api.onVolume((volume) => {
  gain.gain.value = volume;
});
api.onState((state) => {
  baseStatus = state.status === "speaking" ? "idle" : state.status;
  if (typeof state.progress === "number") root.style.setProperty("--progress", state.progress.toFixed(3));
  setSpeaking(current !== null);
  orb.title = state.detail ? `Breathing: ${state.detail}` : "Breathing: click to stop, right click for menu";
});

let dragStart: { x: number; y: number } | null = null;
let dragged = false;

orb.addEventListener("mouseenter", () => api.hover(true));
orb.addEventListener("mouseleave", () => {
  if (!dragStart) api.hover(false);
});
orb.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  dragStart = { x: event.screenX, y: event.screenY };
  dragged = false;
});
window.addEventListener("mousemove", (event) => {
  if (!dragStart) return;
  const dx = event.screenX - dragStart.x;
  const dy = event.screenY - dragStart.y;
  if (!dragged && Math.hypot(dx, dy) < 4) return;
  dragged = true;
  dragStart = { x: event.screenX, y: event.screenY };
  api.dragBy(dx, dy);
});
window.addEventListener("mouseup", (event) => {
  if (!dragStart) return;
  dragStart = null;
  if (dragged) api.dragEnd();
  else if (event.button === 0) api.click();
  if (!orb.matches(":hover")) api.hover(false);
});
orb.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  api.contextMenu();
});

api.ready();
