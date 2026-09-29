import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../server/store";
import {
  NotificationPermission,
  canNotify,
  type NativeNotificationPermission,
} from "../desktop/notification-permission";
import type { DesktopNotificationPermission } from "../shared/desktop";

test("permission status is persisted, rechecked against macOS, and not inferred from cached approval", async (t) => {
  const directory = mkdtempSync(join(tmpdir(), "fieldwork-permission-"));
  const store = new Store(directory);
  t.after(() => {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let status: NativeNotificationPermission["status"] = "not-determined";
  let prompts = 0;
  const native = async (
    ask: boolean,
  ): Promise<NativeNotificationPermission> => {
    const didRequest = ask && status === "not-determined";
    if (didRequest) {
      prompts++;
      status = "authorized";
    }
    return {
      status,
      didRequest,
      alertsEnabled: status === "authorized",
      soundsEnabled: status === "authorized",
    };
  };
  const service = new NotificationPermission(store, native);
  assert.equal((await service.check()).status, "not-determined");
  assert.equal(prompts, 0);
  const allowed = await service.check(true);
  assert.equal(canNotify(allowed), true);
  assert.ok(allowed.requestedAt);
  assert.deepEqual(
    store.setting("desktopNotificationPermission", null),
    allowed,
  );
  await service.check(true);
  assert.equal(prompts, 1);
  status = "denied";
  const restarted = new NotificationPermission(store, native);
  const denied = await restarted.check(true);
  assert.equal(denied.status, "denied");
  assert.equal(canNotify(denied), false);
  assert.equal(denied.requestedAt, allowed.requestedAt);
  assert.equal(prompts, 1);
});

test("simultaneous permission requests share one prompt and OS failures do not become approval", async () => {
  const records = new Map<string, unknown>();
  const store = {
    setting: <T>(key: string, fallback: T): T =>
      (records.get(key) as T) ?? fallback,
    set: (key: string, value: unknown) => {
      records.set(key, value);
    },
  };
  let calls = 0;
  let finish!: (value: NativeNotificationPermission) => void;
  const service = new NotificationPermission(store, async () => {
    calls++;
    return new Promise((resolve) => {
      finish = resolve;
    });
  });
  const a = service.check(true);
  const b = service.check(true);
  const read = service.check();
  assert.equal(calls, 1);
  finish({
    status: "denied",
    alertsEnabled: false,
    soundsEnabled: false,
    didRequest: true,
  });
  assert.deepEqual(await a, await b);
  assert.deepEqual(await a, await read);
  const failed = new NotificationPermission(store, async () => {
    throw new Error("native internal details");
  });
  const result = await failed.check(true);
  assert.equal(result.status, "unavailable");
  assert.equal(canNotify(result), false);
  assert.ok(result.error);
  assert.equal(result.error.includes("internal details"), false);
});

test("permission result arriving after shutdown does not write to a closed store", async () => {
  let finish!: (value: NativeNotificationPermission) => void;
  let writes = 0;
  const service = new NotificationPermission(
    {
      setting: <T>(_key: string, fallback: T) => fallback,
      set: () => {
        writes++;
      },
    },
    async () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = service.check(true);
  service.stop();
  finish({
    status: "authorized",
    alertsEnabled: true,
    soundsEnabled: true,
    didRequest: true,
  });
  assert.equal(
    canNotify((await result) as DesktopNotificationPermission),
    true,
  );
  assert.equal(writes, 0);
});
