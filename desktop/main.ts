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
import { desktopVault } from "./credentials";
import { isExternalLink, isGoogleAuthorization, isLocalPage } from "./policy";
import type { DesktopPreferences } from "../shared/desktop";

const development = !app.isPackaged;
const liveDevelopment = development && process.argv.includes("--desktop-dev");
app.setName(development ? "Fieldwork Dev" : "Fieldwork");
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
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
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
    tray.setToolTip("Fieldwork — application tracker");
    tray.on("click", showWindow);
  }
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Open Fieldwork", click: showWindow },
      { type: "separator" },
      {
        label: "File scanning and scheduled Gmail sync are active",
        enabled: false,
      },
      {
        label: "Sync Gmail now",
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
                "Gmail sync could not start. Open Settings to check the connection.",
              );
          } catch {
            showWindow();
          }
        },
      },
      { type: "separator" },
      {
        label: "Quit Fieldwork",
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
      message: "Could not open your browser.",
      detail: "Check your default browser in macOS Settings.",
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
    onDiscover: (jobs) => {
      void (async () => {
        const permission = await notificationPermission?.check();
        if (quitting) return;
        if (!permission || !canNotify(permission)) {
          if (runtime)
            runtime.discovery.notificationError =
              "Allow Mac notifications from Discover’s Save preferences or Test Mac notification button. Matches remain in Discover.";
          return;
        }
        if (!Notification.isSupported())
          throw new Error("Notifications unavailable.");
        // Limit bursts; every match remains visible in Discover.
        for (const job of jobs.slice(0, 3)) {
          const notification = new Notification({
            title: `${job.company} is hiring`,
            body: `${job.title}\n${job.location || "Location not listed"}`,
            silent: false,
          });
          notification.on("click", () => {
            showWindow();
            void openExternal(job.url);
          });
          notification.on("failed", () => {
            if (runtime)
              runtime.discovery.notificationError =
                "macOS could not display an alert. Check System Settings → Notifications → Fieldwork.";
          });
          notification.show();
        }
        if (jobs.length > 3) {
          const summary = new Notification({
            title: "More new SWE matches",
            body: `${jobs.length - 3} additional roles. Open Discover to see all matches.`,
          });
          summary.on("click", () => {
            showWindow();
            if (window && runtime)
              void window.loadURL(`${runtime.origin}/?view=discover`);
          });
          summary.show();
        }
      })().catch(() => {
        if (runtime)
          runtime.discovery.notificationError =
            "Could not show Mac notifications. Check notification permission in Discover.";
      });
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
    title: "Fieldwork",
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
      title: "Save Fieldwork export",
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
  ipcMain.handle("desktop:notification-permission", (event) => {
    trust(event);
    return notificationPermission!.check();
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
      throw new Error("Notifications are unavailable on this system.");
    const notification = new Notification({
      title: "Fieldwork alerts are ready",
      body: "New matching software engineering roles will appear here while Fieldwork is running.",
    });
    notification.on("failed", () => {
      if (runtime)
        runtime.discovery.notificationError =
          "The test notification failed. Check macOS notification settings and the app’s code signing.";
    });
    notification.show();
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
      title: "Choose your application links file",
      properties: ["openFile"],
      filters: [{ name: "Text files", extensions: ["txt"] }],
    });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });
  ipcMain.handle("desktop:open-data", async (event) => {
    trust(event);
    const error = await shell.openPath(dataDirectory);
    if (error) throw new Error("Could not open the data folder.");
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
        label: "Fieldwork",
        submenu: [
          { role: "about" },
          { type: "separator" },
          { role: "hide" },
          { role: "hideOthers" },
          { role: "unhide" },
          { type: "separator" },
          { role: "quit" },
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
  if (development) console.log("Fieldwork desktop ready.");
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
    window.setTitle("Fieldwork — finishing pending work…");
    window.hide();
  }
  void (async () => {
    try {
      await runtime?.stop();
    } finally {
      quitComplete = true;
      app.quit();
    }
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
      "Fieldwork could not start",
      error instanceof Error ? error.message : "Try reopening the app.",
    );
    app.quit();
  });
}
