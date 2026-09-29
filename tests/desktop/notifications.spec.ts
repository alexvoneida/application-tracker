import { test, expect, _electron as electron } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Store } from "../../server/store";

test("Mac notification permission is requested on save/test, persisted, and rechecked after denial", async () => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-notification-ui-"));
  const executablePath = process.env.FIELDWORK_PACKAGED_EXECUTABLE;
  const desktop = await electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: executablePath
      ? [`--fieldwork-data-dir=${directory}`]
      : [resolve(".")],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      TRACKER_DESKTOP_DATA_DIR: directory,
    },
  });
  try {
    const page = await desktop.firstWindow();
    await expect(
      page.getByRole("heading", { name: "how it's going" }),
    ).toBeVisible();
    // Load the real native bridge, but replace OS calls before any permission
    // requests: tests must never answer or change the user's system consent.
    const observed = await desktop.evaluate(
      async ({ app, Notification, shell }) => {
        const load = process
          .getBuiltinModule("node:module")
          .createRequire(`${app.getAppPath()}/package.json`);
        const native = load(
          `${app.getAppPath()}/.desktop-build/notification-permissions.node`,
        );
        if (typeof native.permission !== "function")
          throw new Error("Native bridge not loaded.");
        const observed = await native.permission(false);
        const fixture = ((globalThis as any).__notificationFixture = {
          status: "not-determined",
          response: "authorized",
          prompts: 0,
          sent: 0,
          settingsUrl: "",
        });
        native.permission = async (ask: boolean) => {
          const didRequest = ask && fixture.status === "not-determined";
          if (didRequest) {
            fixture.prompts++;
            fixture.status = fixture.response;
          }
          return {
            status: fixture.status,
            alertsEnabled: fixture.status === "authorized",
            soundsEnabled: true,
            didRequest,
          };
        };
        Notification.prototype.show = () => {
          fixture.sent++;
        };
        shell.openExternal = async (url: string) => {
          fixture.settingsUrl = url;
        };
        return observed;
      },
    );
    expect(["not-determined", "denied", "authorized", "provisional"]).toContain(
      observed.status,
    );
    await page.getByRole("button", { name: "find jobs", exact: true }).click();
    await page.getByText("filters & alerts", { exact: true }).click();
    await expect(
      page.getByText("haven't allowed or blocked notifications yet", {
        exact: true,
      }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "save filters", exact: true })
      .click();
    await expect(
      page.getByText("saved. notifications are on", { exact: true }),
    ).toBeVisible();
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__notificationFixture.prompts,
      ),
    ).toBe(1);
    const store = new Store(directory);
    const saved = store.setting<any>("desktopNotificationPermission", null);
    expect(saved.status).toBe("authorized");
    expect(saved.requestedAt).toBeTruthy();
    store.close();
    await page
      .getByRole("button", { name: "test notification", exact: true })
      .click();
    await expect
      .poll(() =>
        desktop.evaluate(() => (globalThis as any).__notificationFixture.sent),
      )
      .toBe(1);
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__notificationFixture.prompts,
      ),
    ).toBe(1);
    await desktop.evaluate(() => {
      (globalThis as any).__notificationFixture.status = "denied";
    });
    await page
      .getByRole("button", { name: "test notification", exact: true })
      .click();
    await expect(
      page.getByText(/notifications are blocked/).first(),
    ).toBeVisible();
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__notificationFixture.sent,
      ),
    ).toBe(1);
    await page
      .getByRole("button", {
        name: "open notification settings",
        exact: true,
      })
      .click();
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__notificationFixture.settingsUrl,
      ),
    ).toBe(
      "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
    );
    // Simulate a fresh undecided system state to verify the Test entry point.
    await desktop.evaluate(() => {
      (globalThis as any).__notificationFixture.status = "not-determined";
    });
    await page
      .getByRole("button", { name: "test notification", exact: true })
      .click();
    await expect
      .poll(() =>
        desktop.evaluate(
          () => (globalThis as any).__notificationFixture.prompts,
        ),
      )
      .toBe(2);
    // Saving an opt-out must not ask for OS notification access.
    await desktop.evaluate(() => {
      (globalThis as any).__notificationFixture.status = "not-determined";
    });
    await page.getByLabel("notify me about new matches").uncheck();
    await page
      .getByRole("button", { name: "save filters", exact: true })
      .click();
    await expect(
      page.getByText(
        "saved. alerts use these filters now; jobs already found are still here.",
        { exact: true },
      ),
    ).toBeVisible();
    expect(
      await desktop.evaluate(
        () => (globalThis as any).__notificationFixture.prompts,
      ),
    ).toBe(2);
  } finally {
    await desktop.close();
  }
});
