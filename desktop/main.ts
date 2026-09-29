import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  Notification,
  nativeImage,
  shell,
  Tray,
  type IpcMainInvokeEvent,
} from "electron";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import {
  NotificationPermission,
  canNotify,
  type NativeNotificationPermission,
} from "./notification-permission";
import { startServer } from "../server/runtime";
import { stopClaudeCode } from "../server/claude-code";
import { desktopVault } from "./credentials";
import {
  isExternalLink,
  isGoogleAuthorization,
  isLocalPage,
  settleWithin,
} from "./policy";
import type { DesktopPreferences } from "../shared/desktop";

const development = !app.isPackaged;
const liveDevelopment = development && process.argv.includes("--desktop-dev");
// The internal name stays "Fieldwork" even though the app is now called
// "application tracker": it names the data folder and the Keychain entry that
// protects saved credentials, so changing it would strand both.
app.setName(development ? "Fieldwork Dev" : "Fieldwork");
const displayName = development
  ? "application tracker (dev)"
  : "application tracker";
app.setAboutPanelOptions({ applicationName: displayName });
// No checkout .env in desktop mode. An explicit profile switch permits isolated
// recovery/testing without touching the normal Application Support directory.
const profile = app.commandLine.getSwitchValue("fieldwork-data-dir");
const dataDirectory = profile
  ? resolve(profile)
  : development && process.env.TRACKER_DESKTOP_DATA_DIR
    ? resolve(process.env.TRACKER_DESKTOP_DATA_DIR)
    : join(app.getPath("appData"), app.getName());
app.setPath("userData", dataDirectory);
process.umask(0o077);
mkdirSync(dataDirectory, { recursive: true, mode: 0o700 });

let window: BrowserWindow | undefined;
let tray: Tray | undefined;
let runtime: Awaited<ReturnType<typeof startServer>> | undefined;
const shutdownMilliseconds = 10_000;
let quitting = false;
let quitComplete = false;
let keepRunning = false;
let notificationPermission: NotificationPermission | undefined;
const nativeRequire = createRequire(join(app.getAppPath(), "package.json"));

function preferences(): DesktopPreferences {
  return {
    keepRunningInMenuBar: keepRunning,
    dataDirectory,
    version: app.getVersion(),
    development,
  };
}

function showWindow() {
  // The local server is already closing, so a re-shown window could not save.
  if (quitting || !window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

const notificationPermissionMessage =
  "notifications aren't allowed yet. hit save or test notification in find jobs to allow them (matches still show up there)";
// Electron may garbage-collect a Notification after show(), silently dropping
// its click and failed handlers, so each one is held until it is finished.
const shownNotifications = new Set<Notification>();

function showNotification(
  options: Electron.NotificationConstructorOptions,
  onClick: () => void,
  failure: string,
) {
  const notification = new Notification(options);
  const release = () => shownNotifications.delete(notification);
  notification.on("click", () => {
    release();
    onClick();
  });
  notification.on("close", release);
  notification.on("failed", () => {
    release();
    if (runtime) runtime.discovery.notificationError = failure;
  });
  shownNotifications.add(notification);
  // macOS may never report "close" for alerts left in Notification Center.
  if (shownNotifications.size > 50)
    shownNotifications.delete(shownNotifications.values().next().value!);
  notification.show();
}

function clearNotificationError(onlyPermission: boolean) {
  if (!runtime) return;
  if (
    !onlyPermission ||
    runtime.discovery.notificationError === notificationPermissionMessage
  )
    runtime.discovery.notificationError = "";
}

function updateTray() {
  if (!keepRunning) {
    tray?.destroy();
    tray = undefined;
    return;
  }
  if (!tray) {
    const icon = nativeImage.createFromPath(
      join(__dirname, "trayTemplate.png"),
    );
    icon.setTemplateImage(true);
    tray = new Tray(icon);
    tray.setToolTip(displayName);
    tray.on("click", showWindow);
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: `open ${displayName}`, click: showWindow },
      { type: "separator" },
      {
        label: "links file + gmail sync are running",
        enabled: false,
      },
      {
        label: "sync gmail now",
        enabled: Boolean(runtime?.tracker.vault.get("gmailTokens")),
        click: async () => {
          // Use the same local API and per-process token as the window.
          if (!runtime) return;
          try {
            const state = await (
              await fetch(`${runtime.origin}/api/state`)
            ).json();
            const result = await fetch(`${runtime.origin}/api/gmail/sync`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                "X-Tracker-Token": state.csrf,
              },
              body: JSON.stringify({ full: false }),
            });
            if (!result.ok)
              throw new Error(
                "gmail sync didn't start. check the connection in settings.",
              );
          } catch {
            showWindow();
          }
        },
      },
      { type: "separator" },
      {
        label: `quit ${displayName}`,
        accelerator: "Command+Q",
        click: () => app.quit(),
      },
    ]),
  );
}

function trust(event: IpcMainInvokeEvent) {
  if (
    !window ||
    !runtime ||
    event.sender !== window.webContents ||
    event.senderFrame !== window.webContents.mainFrame ||
    !isLocalPage(event.senderFrame.url, runtime.origin)
  )
    throw new Error("Untrusted desktop request.");
}

async function openExternal(url: string) {
  if (!isExternalLink(url)) return;
  try {
    await shell.openExternal(url);
  } catch {
    void dialog.showMessageBox({
      type: "error",
      message: "couldn't open the browser",
      detail: "check the default browser in macos settings",
    });
  }
}

async function start() {
  await app.whenReady();
  if (process.platform !== "darwin")
    throw new Error("This desktop build currently supports macOS only.");
  runtime = await startServer({
    directory: dataDirectory,
    root: app.getAppPath(),
    production: !liveDevelopment,
    vault: await desktopVault(dataDirectory),
    onDiscover: async (jobs) => {
      const permission = await notificationPermission?.check();
      if (quitting) return;
      if (!permission || !canNotify(permission))
        throw new Error(notificationPermissionMessage);
      if (!Notification.isSupported())
        throw new Error(
          "couldn't show notifications. check the permission in find jobs.",
        );
      // Limit bursts; every match remains visible in Discover.
      for (const job of jobs.slice(0, 3))
        showNotification(
          {
            title: `${job.company} is hiring`,
            body: `${job.title}\n${job.location || "location not listed"}`,
            silent: false,
          },
          () => {
            showWindow();
            void openExternal(job.url);
          },
          "macos couldn't show the notification. check system settings → notifications → application tracker.",
        );
      if (jobs.length > 3)
        showNotification(
          {
            title: "more new matches",
            body: `${jobs.length - 3} more, open find jobs to see them all`,
          },
          () => {
            showWindow();
            if (window && runtime)
              void window.loadURL(`${runtime.origin}/?view=discover`);
          },
          "macos couldn't show the notification. check system settings → notifications → application tracker.",
        );
    },
    onOAuthComplete: (connected) => {
      updateTray();
      showWindow();
      if (runtime && window)
        void window.loadURL(
          `${runtime.origin}/?gmail=${connected ? "connected" : "failed"}`,
        );
    },
  });
  notificationPermission = new NotificationPermission(
    runtime.tracker.store,
    (ask) => {
      const native = nativeRequire(
        join(app.getAppPath(), ".desktop-build/notification-permissions.node"),
      ) as {
        permission(request: boolean): Promise<NativeNotificationPermission>;
      };
      return native.permission(ask);
    },
  );
  keepRunning =
    runtime.tracker.store.setting<boolean>(
      "desktopKeepRunningInMenuBar",
      false,
    ) === true;
  window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 800,
    minHeight: 580,
    title: displayName,
    backgroundColor: "#f5f5ef",
    show: false,
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  window.webContents.session.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  window.webContents.session.setPermissionCheckHandler(() => false);
  window.webContents.setWindowOpenHandler(({ url }) => {
    void openExternal(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (runtime && isLocalPage(url, runtime.origin)) return;
    event.preventDefault();
    void openExternal(url);
  });
  window.webContents.on("will-redirect", (event, url) => {
    if (!runtime || !isLocalPage(url, runtime.origin)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.session.on("will-download", (event, item, contents) => {
    if (
      contents !== window?.webContents ||
      !runtime ||
      !isLocalPage(item.getURL(), runtime.origin)
    ) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      title: "save export",
      defaultPath: join(app.getPath("downloads"), item.getFilename()),
    });
  });
  window.on("close", (event) => {
    if (quitComplete) return;
    event.preventDefault();
    if (keepRunning && !quitting) window?.hide();
    else app.quit();
  });
  ipcMain.handle("desktop:preferences", (event) => {
    trust(event);
    return preferences();
  });
  ipcMain.handle("desktop:notification-permission", async (event) => {
    trust(event);
    const permission = await notificationPermission!.check();
    if (canNotify(permission)) clearNotificationError(true);
    return permission;
  });
  ipcMain.handle("desktop:request-notification-permission", (event) => {
    trust(event);
    return notificationPermission!.check(true);
  });
  ipcMain.handle("desktop:notification-settings", async (event) => {
    trust(event);
    // Fixed OS settings target only; renderer cannot open arbitrary protocols.
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
  });
  ipcMain.handle("desktop:test-notification", async (event) => {
    trust(event);
    const permission = await notificationPermission!.check(true);
    if (!canNotify(permission) || quitting) return permission;
    if (!Notification.isSupported())
      throw new Error("notifications don't work on this system");
    clearNotificationError(false);
    showNotification(
      {
        title: "application tracker notifications work",
        body: "new job matches will show up like this while the app is open",
      },
      showWindow,
      "test notification failed. check macos notification settings (and that the app is signed)",
    );
    return permission;
  });
  ipcMain.handle("desktop:keep-running", (event, enabled: unknown) => {
    trust(event);
    if (typeof enabled !== "boolean")
      throw new Error("Expected a boolean setting.");
    runtime!.tracker.store.set("desktopKeepRunningInMenuBar", enabled);
    keepRunning = enabled;
    updateTray();
    return preferences();
  });
  ipcMain.handle("desktop:choose-links", async (event) => {
    trust(event);
    const result = await dialog.showOpenDialog(window!, {
      title: "pick the links file",
      properties: ["openFile"],
      filters: [{ name: "text files", extensions: ["txt"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("desktop:open-data", async (event) => {
    trust(event);
    const error = await shell.openPath(dataDirectory);
    if (error) throw new Error("couldn't open the data folder");
  });
  ipcMain.handle("desktop:google-auth", async (event, url: unknown) => {
    trust(event);
    if (!isGoogleAuthorization(url))
      throw new Error("Invalid Google authorization URL.");
    await shell.openExternal(url);
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: displayName,
        submenu: [
          { role: "about", label: `about ${displayName}` },
          { type: "separator" },
          { role: "hide", label: `hide ${displayName}` },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit", label: `quit ${displayName}` },
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [
          { role: "reload" },
          { role: "resetZoom" },
          { role: "zoomIn" },
          { role: "zoomOut" },
          { role: "togglefullscreen" },
          ...(development ? [{ role: "toggleDevTools" as const }] : []),
        ],
      },
      { role: "windowMenu" },
    ]),
  );
  updateTray();
  await window.loadURL(runtime.origin);
  showWindow();
  if (development) console.log("desktop app ready.");
}

app.on("before-quit", (event) => {
  if (quitComplete) return;
  event.preventDefault();
  if (quitting) return;
  quitting = true;
  notificationPermission?.stop();
  tray?.destroy();
  tray = undefined;
  if (window && !window.isDestroyed()) {
    window.setTitle(`${displayName} — finishing up…`);
    window.hide();
  }
  void (async () => {
    // A stuck request or Claude Code call must not leave an invisible process
    // holding the single-instance lock, so stop waiting after the limit.
    const drained = await settleWithin(
      runtime?.stop().catch((error) => {
        console.error("couldn't finish pending work:", error);
      }) ?? Promise.resolve(),
      shutdownMilliseconds,
    );
    if (!drained) {
      // exit() rather than quit(): the killed extraction's rejection handlers
      // must not run and record "failed" results while the store shuts down.
      stopClaudeCode();
      console.error(
        `quit before pending work finished (waited ${shutdownMilliseconds / 1000}s)`,
      );
      app.exit(0);
      return;
    }
    quitComplete = true;
    app.quit();
  })();
});
app.on("window-all-closed", () => {
  if (!keepRunning) app.quit();
});
app.on("activate", showWindow);
process.on("SIGTERM", () => app.quit());
process.on("SIGINT", () => app.quit());

if (!app.requestSingleInstanceLock()) {
  quitComplete = true;
  app.quit();
} else {
  app.on("second-instance", showWindow);
  void start().catch((error) => {
    dialog.showErrorBox(
      `${displayName} couldn't start`,
      error instanceof Error ? error.message : "try opening it again",
    );
    app.quit();
  });
}
