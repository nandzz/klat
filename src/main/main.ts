import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  Menu,
  nativeImage,
  type NativeImage,
  Notification,
  screen,
  Tray,
  type MenuItemConstructorOptions,
} from "electron";
import { join } from "node:path";
import type { DropFilter, MenuAction, MenuState, OrbState, PlayerEvent, SpeechChunk, SpeechKind } from "../shared/types.js";
import { runInstaller } from "./installer.js";
import { McpHttpServer } from "./mcp-server.js";
import { SpeechQueue, type Player } from "./queue.js";
import { settings } from "./settings.js";
import { TtsEngine } from "./tts.js";

const ORB_SIZE = { width: 340, height: 240 };
const SPEEDS = [0.8, 0.9, 1, 1.1, 1.2, 1.35, 1.5];
const VOLUMES = [0.25, 0.5, 0.75, 1];
const UNLOAD_OPTIONS: Array<[string, number]> = [
  ["After 5 minutes", 5],
  ["After 10 minutes", 10],
  ["After 30 minutes", 30],
  ["Never", 0],
];

if (!app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

let tray: Tray | null = null;
let orb: BrowserWindow | null = null;
let orbReady = false;
const orbBacklog: Array<[string, unknown]> = [];
let loadProgress = 0;
let engineStatus: "loading" | "ready" | "sleeping" | "error" = "loading";
let engineError = "";
let serverError = "";
let quitting = false;

const tts = new TtsEngine();

const player: Player = {
  enqueue: (chunk: SpeechChunk) => sendToOrb("player:enqueue", chunk),
  drop: (filter: DropFilter) => sendToOrb("player:drop", filter),
};

const queue = new SpeechQueue(tts, player, () => ({ voice: settings.get().voice, speed: settings.get().speed }));

const mcp = new McpHttpServer(
  {
    isMuted: () => settings.get().muted,
    speak: (text: string, kind: SpeechKind, source: string, interrupt: boolean) =>
      queue.speak({ text, kind, source, interrupt }),
    stop: () => queue.stopAll(),
    status: () => ({
      muted: settings.get().muted,
      model: engineStatus,
      ...queue.status(),
      voice: settings.get().voice,
      speed: settings.get().speed,
    }),
  },
  app.getVersion(),
);

function sendToOrb(channel: string, value: unknown): void {
  if (orb && orbReady) orb.webContents.send(channel, value);
  else orbBacklog.push([channel, value]);
}

function asset(name: string): string {
  return join(app.getAppPath(), "assets", name);
}

function orbState(): OrbState & { progress: number } {
  if (engineStatus === "error") return { status: "error", detail: engineError, progress: 0 };
  if (serverError) return { status: "error", detail: serverError, progress: 0 };
  if (settings.get().muted) return { status: "muted", detail: "muted", progress: 1 };
  if (engineStatus === "loading") return { status: "loading", detail: `loading voice ${Math.round(loadProgress * 100)}%`, progress: loadProgress };
  return { status: queue.status().speaking ? "speaking" : "idle", progress: 1 };
}

function refresh(): void {
  sendToOrb("orb:state", orbState());
  updateTray();
}

function defaultOrbPosition(): { x: number; y: number } {
  const area = screen.getPrimaryDisplay().workArea;
  return { x: area.x + area.width - ORB_SIZE.width - 12, y: area.y + area.height - ORB_SIZE.height - 12 };
}

function visiblePosition(position: { x: number; y: number } | null): { x: number; y: number } {
  if (!position) return defaultOrbPosition();
  const inside = screen.getAllDisplays().some((display) => {
    const a = display.workArea;
    return position.x + ORB_SIZE.width > a.x + 40 && position.x < a.x + a.width - 40 && position.y >= a.y - 20 && position.y + ORB_SIZE.height <= a.y + a.height + 20;
  });
  return inside ? position : defaultOrbPosition();
}

function createOrb(): void {
  const position = visiblePosition(settings.get().orbPosition);
  orb = new BrowserWindow({
    ...ORB_SIZE,
    ...position,
    frame: false,
    transparent: true,
    resizable: false,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    focusable: false,
    skipTaskbar: true,
    hasShadow: false,
    alwaysOnTop: true,
    show: false,
    webPreferences: {
      preload: join(import.meta.dirname, "..", "preload", "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      autoplayPolicy: "no-user-gesture-required",
    },
  });
  orb.setAlwaysOnTop(true, "floating");
  orb.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  orb.setIgnoreMouseEvents(true, { forward: true });
  orb.loadFile(join(import.meta.dirname, "..", "renderer", "orb.html"));
  orb.on("closed", () => {
    orb = null;
    orbReady = false;
  });
}

function setOrbVisible(visible: boolean): void {
  if (!orb) return;
  if (visible) orb.showInactive();
  else orb.hide();
}

function speakTest(text = "Hi. I'm your coding assistant's voice. I'll tell you when something is ready to look at."): void {
  if (settings.get().muted) settings.update({ muted: false });
  queue.speak({ text, kind: "summary", source: "breathing", interrupt: true });
}

function toggleMute(): void {
  const muted = !settings.get().muted;
  settings.update({ muted });
  if (muted) queue.stopAll();
}

function trayIcon(): NativeImage {
  const status = orbState().status;
  const name = status === "muted" ? "tray-mutedTemplate.png" : status === "speaking" ? "tray-speakingTemplate.png" : "trayTemplate.png";
  const image = nativeImage.createFromPath(asset(name));
  image.setTemplateImage(true);
  return image;
}

function statusLine(): string {
  if (engineStatus === "error") return `Voice error: ${engineError}`;
  if (serverError) return serverError;
  if (engineStatus === "loading") return `Loading voice model… ${Math.round(loadProgress * 100)}%`;
  const status = queue.status();
  if (settings.get().muted) return "Muted";
  if (status.current) return `Speaking (${status.current.source})`;
  if (status.speaking) return "Preparing speech…";
  if (engineStatus === "sleeping") return "Ready (voice unloaded to save memory)";
  return "Ready";
}

function voiceMenu(): MenuItemConstructorOptions[] {
  if (tts.voices.length === 0) return [{ label: "Loading…", enabled: false }];
  const groups: Array<[string, (id: string) => boolean]> = [
    ["American female", (id) => id.startsWith("af_")],
    ["American male", (id) => id.startsWith("am_")],
    ["British female", (id) => id.startsWith("bf_")],
    ["British male", (id) => id.startsWith("bm_")],
  ];
  const items: MenuItemConstructorOptions[] = [];
  for (const [title, test] of groups) {
    if (items.length) items.push({ type: "separator" });
    items.push({ label: title, enabled: false });
    for (const voice of tts.voices.filter((v) => test(v.id))) {
      items.push({
        label: `${voice.name}  ·  ${voice.grade}`,
        type: "radio",
        checked: settings.get().voice === voice.id,
        click: () => {
          settings.update({ voice: voice.id });
          speakTest(`Hi, I'm ${voice.name}.`);
        },
      });
    }
  }
  return items;
}

function orbMenuState(): MenuState {
  const status = queue.status();
  const repeat = queue.canRepeat();
  const muted = settings.get().muted;
  return {
    muted,
    enabled: {
      "repeat-sentence": repeat.sentence && !muted,
      "repeat-message": repeat.message && !muted,
      stop: status.speaking || status.queued > 0,
    },
  };
}

function runMenuAction(action: MenuAction): void {
  if (action === "repeat-sentence") queue.repeatLastSentence();
  else if (action === "repeat-message") queue.repeatLastMessage();
  else if (action === "stop") queue.stopAll();
  else if (action === "mute") toggleMute();
}

function buildMenu(): Menu {
  const s = settings.get();
  const status = queue.status();
  const template: MenuItemConstructorOptions[] = [
    { label: statusLine(), enabled: false },
    { type: "separator" },
    { label: "Mute", type: "checkbox", checked: s.muted, accelerator: s.muteHotkey, click: toggleMute },
    { label: "Stop speaking", enabled: status.speaking || status.queued > 0, accelerator: s.stopHotkey, click: () => queue.stopAll() },
    { label: "Repeat last sentence", enabled: queue.canRepeat().sentence && !s.muted, click: () => queue.repeatLastSentence() },
    { type: "separator" },
    { label: "Voice", submenu: voiceMenu() },
    {
      label: "Speed",
      submenu: SPEEDS.map((speed) => ({
        label: `${speed}×`,
        type: "radio" as const,
        checked: Math.abs(s.speed - speed) < 0.001,
        click: () => settings.update({ speed }),
      })),
    },
    {
      label: "Volume",
      submenu: VOLUMES.map((volume) => ({
        label: `${Math.round(volume * 100)}%`,
        type: "radio" as const,
        checked: Math.abs(s.volume - volume) < 0.001,
        click: () => settings.update({ volume }),
      })),
    },
    {
      label: "Free memory when idle",
      submenu: UNLOAD_OPTIONS.map(([label, minutes]) => ({
        label,
        type: "radio" as const,
        checked: s.unloadAfterMinutes === minutes,
        click: () => settings.update({ unloadAfterMinutes: minutes }),
      })),
    },
    { label: "Show orb", type: "checkbox", checked: s.showOrb, click: () => settings.update({ showOrb: !settings.get().showOrb }) },
    engineStatus === "error"
      ? { label: "Retry loading the voice", click: () => void retryEngine() }
      : { label: "Speak a test sentence", enabled: engineStatus === "ready" || engineStatus === "sleeping", click: () => speakTest() },
    { type: "separator" },
    { label: "Install for Claude Code and Codex…", click: () => void runInstaller(settings.get().port) },
    { label: "Copy MCP server URL", click: () => clipboard.writeText(`http://127.0.0.1:${settings.get().port}/mcp`) },
    {
      label: "Start at login",
      type: "checkbox",
      checked: app.getLoginItemSettings().openAtLogin,
      enabled: app.isPackaged,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: "Quit Breathing", accelerator: "Command+Q", click: () => app.quit() },
  ];
  return Menu.buildFromTemplate(template);
}

function updateTray(): void {
  if (!tray) return;
  tray.setImage(trayIcon());
  tray.setToolTip(`Breathing: ${statusLine()}`);
}

function registerHotkeys(): void {
  globalShortcut.unregisterAll();
  const s = settings.get();
  const failed: string[] = [];
  if (!globalShortcut.register(s.stopHotkey, () => queue.stopAll())) failed.push(s.stopHotkey);
  if (!globalShortcut.register(s.muteHotkey, toggleMute)) failed.push(s.muteHotkey);
  if (failed.length) console.warn(`Hotkeys not registered: ${failed.join(", ")}`);
}

function wireIpc(): void {
  ipcMain.on("orb:ready", () => {
    orbReady = true;
    orb?.webContents.send("player:volume", settings.get().volume);
    for (const [channel, value] of orbBacklog.splice(0)) orb?.webContents.send(channel, value);
    orb?.webContents.send("orb:state", orbState());
  });
  ipcMain.on("player:event", (_event, value: PlayerEvent) => queue.onPlayerEvent(value));
  ipcMain.on("orb:click", () => orb?.webContents.send("orb:menu", orbMenuState()));
  ipcMain.on("orb:menu-action", (_event, action: MenuAction) => runMenuAction(action));
  ipcMain.on("orb:context-menu", () => buildMenu().popup({ window: orb ?? undefined }));
  ipcMain.on("orb:hover", (_event, inside: boolean) => {
    if (inside) orb?.setIgnoreMouseEvents(false);
    else orb?.setIgnoreMouseEvents(true, { forward: true });
  });
  ipcMain.on("orb:drag", (_event, dx: number, dy: number) => {
    if (!orb) return;
    const [x, y] = orb.getPosition();
    orb.setPosition(Math.round(x! + dx), Math.round(y! + dy));
  });
  ipcMain.on("orb:drag-end", () => {
    if (!orb) return;
    const [x, y] = orb.getPosition();
    settings.update({ orbPosition: { x: x!, y: y! } });
  });
}

async function startServer(): Promise<void> {
  const port = settings.get().port;
  try {
    await mcp.listen(port);
    serverError = "";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    serverError = code === "EADDRINUSE" ? `Port ${port} is in use` : `MCP server failed: ${String(error)}`;
    new Notification({ title: "Breathing", body: `${serverError}. Agents cannot connect.` }).show();
  }
  refresh();
}

app.on("second-instance", () => {
  if (settings.get().showOrb) setOrbVisible(true);
});

app.whenReady().then(async () => {
  app.dock?.hide();
  settings.load();
  wireIpc();
  createOrb();
  if (settings.get().showOrb) setOrbVisible(true);

  tray = new Tray(trayIcon());
  tray.on("click", () => tray?.popUpContextMenu(buildMenu()));
  tray.on("right-click", () => tray?.popUpContextMenu(buildMenu()));

  settings.onChange((current, changed) => {
    if ("showOrb" in changed) setOrbVisible(current.showOrb);
    if ("volume" in changed) sendToOrb("player:volume", current.volume);
    if ("stopHotkey" in changed || "muteHotkey" in changed) registerHotkeys();
    if ("unloadAfterMinutes" in changed) tts.setUnloadAfter(current.unloadAfterMinutes);
    refresh();
  });
  queue.on("state", refresh);
  queue.on("error", (error) => console.error("speech error", error));

  tts.on("ready", () => {
    engineStatus = "ready";
    engineError = "";
    refresh();
  });
  tts.on("progress", (fraction: number) => {
    loadProgress = fraction;
    refresh();
  });
  tts.on("loading", () => {
    engineStatus = "loading";
    loadProgress = 0;
    refresh();
  });
  tts.on("sleep", () => {
    engineStatus = "sleeping";
    refresh();
  });
  tts.on("exit", (code: number, expected: boolean) => {
    if (quitting || expected) return;
    if (engineStatus === "ready") {
      engineStatus = "loading";
      refresh();
      setTimeout(() => void bootEngine(), 1000);
    } else if (engineStatus !== "error") {
      engineStatus = "error";
      engineError = `TTS process exited (${code})`;
      refresh();
    }
  });

  registerHotkeys();
  tts.setUnloadAfter(settings.get().unloadAfterMinutes);
  await startServer();
  await bootEngine();
});

async function retryEngine(): Promise<void> {
  engineStatus = "loading";
  engineError = "";
  loadProgress = 0;
  refresh();
  await bootEngine();
}

async function bootEngine(): Promise<void> {
  try {
    await tts.start();
    engineStatus = "ready";
    engineError = "";
  } catch (error) {
    engineStatus = "error";
    engineError = error instanceof Error ? error.message : String(error);
  }
  refresh();
}

app.on("window-all-closed", () => undefined);

app.on("will-quit", () => {
  quitting = true;
  globalShortcut.unregisterAll();
  tts.stop();
  void mcp.close();
});
