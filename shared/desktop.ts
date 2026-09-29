export interface DesktopPreferences {
  keepRunningInMenuBar: boolean;
  dataDirectory: string;
  version: string;
  development: boolean;
}

export interface DesktopBridge {
  preferences(): Promise<DesktopPreferences>;
  setKeepRunning(enabled: boolean): Promise<DesktopPreferences>;
  chooseLinksFile(): Promise<string | null>;
  openDataDirectory(): Promise<void>;
  openGoogleAuth(url: string): Promise<void>;
  notificationPermission(): Promise<DesktopNotificationPermission>;
  requestNotificationPermission(): Promise<DesktopNotificationPermission>;
  openNotificationSettings(): Promise<void>;
  testNotification(): Promise<DesktopNotificationPermission>;
}

export type NotificationAuthorization =
  "not-determined" | "denied" | "authorized" | "provisional" | "unavailable";
export interface DesktopNotificationPermission {
  status: NotificationAuthorization;
  alertsEnabled: boolean;
  soundsEnabled: boolean;
  checkedAt: string;
  requestedAt: string;
  error: string;
}

declare global {
  interface Window {
    fieldworkDesktop?: DesktopBridge;
  }
}
