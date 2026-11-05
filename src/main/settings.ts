import { app } from "electron";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface Settings {
  voice: string;
  speed: number;
  volume: number;
  muted: boolean;
  showOrb: boolean;
  orbPosition: { x: number; y: number } | null;
  port: number;
  stopHotkey: string;
  muteHotkey: string;
}

export const DEFAULT_PORT = 48613;

const defaults: Settings = {
  voice: "af_heart",
  speed: 1,
  volume: 1,
  muted: false,
  showOrb: true,
  orbPosition: null,
  port: DEFAULT_PORT,
  stopHotkey: "Control+Option+Command+S",
  muteHotkey: "Control+Option+Command+M",
};

type Listener = (settings: Settings, changed: Partial<Settings>) => void;

class SettingsStore {
  private data: Settings = { ...defaults };
  private listeners: Listener[] = [];
  private file = "";

  load(): void {
    this.file = join(app.getPath("userData"), "settings.json");
    if (existsSync(this.file)) {
      try {
        this.data = { ...defaults, ...JSON.parse(readFileSync(this.file, "utf8")) };
      } catch {
        this.data = { ...defaults };
      }
    }
  }

  get(): Settings {
    return this.data;
  }

  update(patch: Partial<Settings>): void {
    this.data = { ...this.data, ...patch };
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    for (const listener of this.listeners) listener(this.data, patch);
  }

  onChange(listener: Listener): void {
    this.listeners.push(listener);
  }
}

export const settings = new SettingsStore();
