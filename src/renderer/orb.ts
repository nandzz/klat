import type { DropFilter, MenuAction, MenuState, OrbState, PlayerEvent, SpeechChunk } from "../shared/types.js";

interface BreathingApi {
  onEnqueue(cb: (chunk: SpeechChunk) => void): void;
  onDrop(cb: (filter: DropFilter) => void): void;
  onVolume(cb: (volume: number) => void): void;
  onState(cb: (state: OrbState & { progress?: number }) => void): void;
  playerEvent(event: PlayerEvent): void;
  click(): void;
  onMenu(cb: (state: MenuState) => void): void;
  menuAction(action: MenuAction): void;
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
const menu = document.getElementById("menu")!;
const root = document.documentElement;

const SENTENCE_GAP_MS = 90;
const REST_AFTER_MS = 20_000;
const SUSPEND_AUDIO_AFTER_MS = 3_000;

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
  startAnimation();
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
  updateRest();
}

let restTimer: number | null = null;
let audioTimer: number | null = null;

function updateRest(): void {
  const busy = current !== null || queue.length > 0 || baseStatus === "loading" || hovering || !menu.hidden;
  if (busy) {
    if (restTimer !== null) window.clearTimeout(restTimer);
    restTimer = null;
    orb.classList.remove("resting");
  } else if (restTimer === null && !orb.classList.contains("resting")) {
    restTimer = window.setTimeout(() => {
      restTimer = null;
      orb.classList.add("resting");
    }, REST_AFTER_MS);
  }
  if (current !== null || queue.length > 0) {
    if (audioTimer !== null) window.clearTimeout(audioTimer);
    audioTimer = null;
  } else if (audioTimer === null && ctx.state === "running") {
    audioTimer = window.setTimeout(() => {
      audioTimer = null;
      if (current === null && queue.length === 0) void ctx.suspend();
    }, SUSPEND_AUDIO_AFTER_MS);
  }
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
let animating = false;

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
  if (current || smoothed > 0.002) {
    requestAnimationFrame(animate);
  } else {
    smoothed = 0;
    root.style.setProperty("--level", "0");
    animating = false;
  }
}

function startAnimation(): void {
  if (animating) return;
  animating = true;
  requestAnimationFrame(animate);
}

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
  orb.title = state.detail ? `Breathing: ${state.detail}` : "Breathing: click for repeat and stop, right click for all settings";
});

let dragStart: { x: number; y: number } | null = null;
let dragged = false;
let hovering = false;
let menuCloseTimer: number | null = null;

function setHover(inside: boolean): void {
  if (inside === hovering) return;
  hovering = inside;
  api.hover(inside);
  updateRest();
}

function isInteractive(target: Element | null): boolean {
  if (!target) return false;
  if (target.closest("#orb")) return true;
  return !menu.hidden && target.closest("#menu") !== null;
}

function openMenu(state: MenuState): void {
  for (const button of menu.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    const action = button.dataset.action as MenuAction;
    if (action === "mute") button.textContent = state.muted ? "Unmute" : "Mute";
    else button.disabled = !state.enabled[action];
  }
  menu.hidden = false;
  updateRest();
  requestAnimationFrame(() => menu.classList.add("open"));
}

function closeMenu(): void {
  if (menuCloseTimer !== null) window.clearTimeout(menuCloseTimer);
  menuCloseTimer = null;
  menu.classList.remove("open");
  menu.hidden = true;
  updateRest();
}

function scheduleMenuClose(): void {
  if (menu.hidden || menuCloseTimer !== null) return;
  menuCloseTimer = window.setTimeout(closeMenu, 700);
}

function cancelMenuClose(): void {
  if (menuCloseTimer !== null) window.clearTimeout(menuCloseTimer);
  menuCloseTimer = null;
}

window.addEventListener("mousemove", (event) => {
  if (dragStart) {
    const dx = event.screenX - dragStart.x;
    const dy = event.screenY - dragStart.y;
    if (!dragged && Math.hypot(dx, dy) < 4) return;
    dragged = true;
    closeMenu();
    dragStart = { x: event.screenX, y: event.screenY };
    api.dragBy(dx, dy);
    return;
  }
  const inside = isInteractive(document.elementFromPoint(event.clientX, event.clientY));
  setHover(inside);
  if (inside) cancelMenuClose();
  else scheduleMenuClose();
});
document.addEventListener("mouseleave", () => {
  if (dragStart) return;
  setHover(false);
  scheduleMenuClose();
});
orb.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  dragStart = { x: event.screenX, y: event.screenY };
  dragged = false;
});
window.addEventListener("mouseup", (event) => {
  if (!dragStart) return;
  dragStart = null;
  if (dragged) api.dragEnd();
  else if (event.button === 0) {
    if (menu.hidden) api.click();
    else closeMenu();
  }
});
orb.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  closeMenu();
  api.contextMenu();
});
menu.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("button[data-action]") : null;
  if (!button || button.disabled) return;
  api.menuAction(button.dataset.action as MenuAction);
  closeMenu();
});

api.onMenu(openMenu);
api.ready();
