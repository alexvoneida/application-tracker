import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge } from "../shared/desktop";

// Only named capabilities, never raw IPC, filesystem access, or credentials.
const bridge: DesktopBridge = {
  preferences: () => ipcRenderer.invoke("desktop:preferences"),
  setKeepRunning: (enabled) =>
    ipcRenderer.invoke("desktop:keep-running", enabled),
  chooseLinksFile: () => ipcRenderer.invoke("desktop:choose-links"),
  openDataDirectory: () => ipcRenderer.invoke("desktop:open-data"),
  openGoogleAuth: (url) => ipcRenderer.invoke("desktop:google-auth", url),
  testNotification: () => ipcRenderer.invoke("desktop:test-notification"),
  notificationPermission: () =>
    ipcRenderer.invoke("desktop:notification-permission"),
  requestNotificationPermission: () =>
    ipcRenderer.invoke("desktop:request-notification-permission"),
  openNotificationSettings: () =>
    ipcRenderer.invoke("desktop:notification-settings"),
};
contextBridge.exposeInMainWorld("fieldworkDesktop", bridge);
