import {
  test,
  expect,
  _electron as electron,
  type ElectronApplication,
} from "@playwright/test";
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

test("desktop tray preference, secure bridge, records and graceful quit survive relaunch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-desktop-"));
  const executablePath = process.env.FIELDWORK_PACKAGED_EXECUTABLE;
  const launch = () =>
    electron.launch({
      ...(executablePath ? { executablePath } : {}),
      args: executablePath
        ? [`--fieldwork-data-dir=${directory}`]
        : [resolve(".")],
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "",
        TRACKER_DESKTOP_DATA_DIR: directory,
        GOOGLE_CLIENT_ID: "",
        GOOGLE_CLIENT_SECRET: "",
        OPENAI_API_KEY: "",
      },
    });
  let desktop: ElectronApplication | undefined;
  try {
    desktop = await launch();
    let page = await desktop.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await expect(
      page.getByRole("heading", { name: "Your search, in perspective." }),
    ).toBeVisible();
    expect(await page.evaluate(() => typeof (globalThis as any).require)).toBe(
      "undefined",
    );
    expect(await page.evaluate(() => typeof (globalThis as any).process)).toBe(
      "undefined",
    );
    const prefs = await page.evaluate(() =>
      window.fieldworkDesktop!.preferences(),
    );
    expect(prefs.dataDirectory).toBe(directory);
    expect(prefs.keepRunningInMenuBar).toBe(false);
    await desktop.evaluate(({ Notification, app }) => {
      const load = process
        .getBuiltinModule("node:module")
        .createRequire(`${app.getAppPath()}/package.json`);
      const native = load(
        `${app.getAppPath()}/.desktop-build/notification-permissions.node`,
      );
      native.permission = async () => ({
        status: "authorized",
        alertsEnabled: true,
        soundsEnabled: true,
        didRequest: false,
      });
      Notification.prototype.show = function () {
        (globalThis as any).__fieldworkTestNotification = {
          title: this.title,
          body: this.body,
        };
      };
    });
    await page.evaluate(() => window.fieldworkDesktop!.testNotification());
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__fieldworkTestNotification.title,
      ),
    ).toContain("Fieldwork");
    await expect(
      page.evaluate(() =>
        window.fieldworkDesktop!.openGoogleAuth("file:///etc/passwd"),
      ),
    ).rejects.toThrow("Invalid Google authorization URL");
    await expect(
      page.evaluate(() =>
        window.fieldworkDesktop!.setKeepRunning("yes" as unknown as boolean),
      ),
    ).rejects.toThrow("Expected a boolean");
    await page
      .getByRole("button", { name: "Add application", exact: true })
      .click();
    await page
      .getByRole("textbox", { name: "Company", exact: true })
      .fill("Desktop persistence");
    await page
      .getByRole("textbox", { name: "Job title", exact: true })
      .fill("Software Engineer");
    await page
      .getByRole("dialog")
      .getByRole("button", { name: "Add application", exact: true })
      .click();
    await page.getByRole("button", { name: "Close dialog" }).click();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    const links = join(directory, "applications.txt");
    writeFileSync(links, "# Desktop test links\n");
    await desktop.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({
        canceled: false,
        filePaths: [path],
      });
    }, links);
    await page.getByRole("button", { name: "Choose text file…" }).click();
    await expect(
      page.getByLabel("Absolute path to your text file"),
    ).toHaveValue(links);
    await page.getByLabel("Provider", { exact: true }).selectOption("openai");
    await page
      .getByLabel("API key", { exact: true })
      .fill("desktop-fixture-key");
    await page.getByRole("button", { name: "Save settings" }).click();
    await expect(
      page.getByText("Settings saved.", { exact: true }),
    ).toBeVisible();
    expect(
      readFileSync(join(directory, "secrets.enc")).includes(
        Buffer.from("desktop-fixture-key"),
      ),
    ).toBe(false);
    const exported = join(directory, "backup.json");
    await desktop.evaluate(({ session }, path) => {
      session.defaultSession.once("will-download", (_event, item) =>
        item.setSavePath(path),
      );
    }, exported);
    await page.getByRole("link", { name: "Download full backup" }).click();
    await expect.poll(() => existsSync(exported)).toBe(true);
    const backup = readFileSync(exported, "utf8");
    expect(JSON.parse(backup).tables.applications[0].company).toBe(
      "Desktop persistence",
    );
    expect(backup).not.toContain("desktop-fixture-key");
    const option = page.getByRole("checkbox", {
      name: "Keep running in the menu bar",
    });
    await expect(option).not.toBeChecked();
    await option.check();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.fieldworkDesktop!.preferences()).keepRunningInMenuBar,
        ),
      )
      .toBe(true);
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    expect(
      await desktop.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isVisible(),
      ),
    ).toBe(false);
    const origin = new URL(page.url()).origin;
    expect((await fetch(`${origin}/api/state`)).ok).toBe(true);
    writeFileSync(links, "https://127.0.0.1/jobs/hidden-window-test\n");
    await expect
      .poll(async () => {
        const state = await (await fetch(`${origin}/api/state`)).json();
        return state.applications.some((item: { url: string }) =>
          item.url.includes("hidden-window-test"),
        );
      })
      .toBe(true);
    // Same handler used by a Dock click and the tray's Open Fieldwork command.
    await desktop.evaluate(({ app }) => app.emit("activate"));
    await expect
      .poll(() =>
        desktop!.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0].isVisible(),
        ),
      )
      .toBe(true);
    expect(errors).toEqual([]);
    const closed = desktop.waitForEvent("close");
    await desktop.evaluate(({ app }) => app.quit());
    await closed;
    desktop = undefined;
    await expect(fetch(`${origin}/api/state`)).rejects.toThrow();
    expect(existsSync(join(directory, "tracker.sqlite"))).toBe(true);
    expect(existsSync(join(directory, "secrets.key"))).toBe(false);
    expect(
      readFileSync(join(directory, "vault-key.enc")).length,
    ).toBeGreaterThan(32);

    desktop = await launch();
    page = await desktop.firstWindow();
    await expect(
      page.getByRole("button", {
        name: "Open Desktop persistence",
        exact: true,
      }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Settings", exact: true }).click();
    await expect(
      page.getByText("Key configured", { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel("API key", { exact: true })).toHaveValue("");
    await expect(
      page.getByRole("checkbox", { name: "Keep running in the menu bar" }),
    ).toBeChecked();
    await page
      .getByRole("checkbox", { name: "Keep running in the menu bar" })
      .uncheck();
    await expect
      .poll(() =>
        page.evaluate(
          async () =>
            (await window.fieldworkDesktop!.preferences()).keepRunningInMenuBar,
        ),
      )
      .toBe(false);
    await page.screenshot({ path: "test-results/mac-settings.png" });
    const exit = desktop.waitForEvent("close");
    await desktop.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].close(),
    );
    await exit;
    desktop = undefined;
  } finally {
    await desktop?.close();
  }
});
