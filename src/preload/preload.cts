import { contextBridge, ipcRenderer } from "electron";

type Callback<T> = (value: T) => void;

function on<T>(channel: string, callback: Callback<T>): void {
  ipcRenderer.on(channel, (_event, value: T) => callback(value));
}

contextBridge.exposeInMainWorld("klat", {
  onEnqueue: (cb: Callback<unknown>) => on("player:enqueue", cb),
  onDrop: (cb: Callback<unknown>) => on("player:drop", cb),
  onVolume: (cb: Callback<number>) => on("player:volume", cb),
  onState: (cb: Callback<unknown>) => on("orb:state", cb),
  playerEvent: (event: unknown) => ipcRenderer.send("player:event", event),
  click: () => ipcRenderer.send("orb:click"),
  onMenu: (cb: Callback<unknown>) => on("orb:menu", cb),
  menuAction: (action: string) => ipcRenderer.send("orb:menu-action", action),
  contextMenu: () => ipcRenderer.send("orb:context-menu"),
  hover: (inside: boolean) => ipcRenderer.send("orb:hover", inside),
  dragBy: (dx: number, dy: number) => ipcRenderer.send("orb:drag", dx, dy),
  dragEnd: () => ipcRenderer.send("orb:drag-end"),
  ready: () => ipcRenderer.send("orb:ready"),
});
