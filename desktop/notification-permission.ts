import type {
  DesktopNotificationPermission,
  NotificationAuthorization,
} from "../shared/desktop";
import type { Store } from "../server/store";

export interface NativeNotificationPermission {
  status: NotificationAuthorization;
  alertsEnabled: boolean;
  soundsEnabled: boolean;
  didRequest: boolean;
}
export const canNotify = (permission: DesktopNotificationPermission) =>
  ["authorized", "provisional"].includes(permission.status);

export class NotificationPermission {
  private active?: Promise<DesktopNotificationPermission>;
  private request?: Promise<DesktopNotificationPermission>;
  private stopped = false;
  constructor(
    private store: Pick<Store, "setting" | "set">,
    private native: (request: boolean) => Promise<NativeNotificationPermission>,
  ) {}
  check(ask = false): Promise<DesktopNotificationPermission> {
    if (this.request) return this.request;
    if (!ask && this.active) return this.active;
    const previous = this.active;
    const work = (async () => {
      if (previous) await previous;
      if (this.stopped) throw new Error("shutting down");
      const saved = this.store.setting<DesktopNotificationPermission | null>(
        "desktopNotificationPermission",
        null,
      );
      const record: DesktopNotificationPermission = {
        status: "unavailable",
        alertsEnabled: false,
        soundsEnabled: false,
        checkedAt: "",
        requestedAt: saved?.requestedAt || "",
        error: "",
      };
      try {
        const result = await this.native(ask);
        if (
          !["not-determined", "denied", "authorized", "provisional"].includes(
            result.status,
          )
        )
          throw new Error("Invalid native permission result.");
        record.status = result.status;
        record.alertsEnabled = result.alertsEnabled;
        record.soundsEnabled = result.soundsEnabled;
        if (result.didRequest) record.requestedAt = new Date().toISOString();
      } catch {
        record.error =
          "couldn't check notification permission. this only works in the built app, then try again.";
      }
      record.checkedAt = new Date().toISOString();
      if (!this.stopped)
        this.store.set("desktopNotificationPermission", record);
      return record;
    })();
    this.active = work;
    if (ask) this.request = work;
    void work
      .finally(() => {
        if (this.active === work) this.active = undefined;
        if (this.request === work) this.request = undefined;
      })
      .catch(() => {});
    return work;
  }
  stop() {
    this.stopped = true;
  }
}
