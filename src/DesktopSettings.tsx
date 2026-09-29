import { useEffect, useState } from "react";
import { Monitor, FolderOpen } from "lucide-react";
import type { DesktopPreferences } from "../shared/desktop";
import { Notice } from "./components";

export function DesktopSettings() {
  const desktop = window.fieldworkDesktop;
  const [preferences, setPreferences] = useState<DesktopPreferences>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (desktop)
      void desktop
        .preferences()
        .then(setPreferences)
        .catch(() => setError("Could not read desktop settings."));
  }, [desktop]);
  if (!desktop) return null;
  return (
    <section className="settings-section">
      <div className="settings-title">
        <Monitor size={21} />
        <div>
          <h2>Desktop app</h2>
          <p>Your workspace, without a terminal.</p>
        </div>
      </div>
      {error && <Notice error>{error}</Notice>}
      <label className="check-label consent">
        <input
          type="checkbox"
          checked={preferences?.keepRunningInMenuBar ?? false}
          disabled={!preferences || busy}
          onChange={async (event) => {
            const previous = preferences;
            const enabled = event.target.checked;
            if (previous)
              setPreferences({ ...previous, keepRunningInMenuBar: enabled });
            setBusy(true);
            setError("");
            try {
              setPreferences(await desktop.setKeepRunning(enabled));
            } catch {
              setPreferences(previous);
              setError(
                "Could not save this desktop setting. Please try again.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>
          Keep running in the menu bar
          <small>
            Closing the window keeps text-file scanning and scheduled Gmail sync
            active. Reopen from the menu bar or Dock. Quit (⌘Q) stops
            everything. Off by default; changes save immediately.
          </small>
        </span>
      </label>
      <p className="small muted">
        This does not launch Fieldwork at login or keep your Mac awake. Sync
        resumes after waking while the app is running.
      </p>
      {preferences && (
        <>
          <p className="small muted desktop-data-path">
            Local records:{" "}
            <code>{preferences.dataDirectory}/tracker.sqlite</code>
          </p>
          <button
            className="button secondary"
            onClick={() =>
              void desktop
                .openDataDirectory()
                .catch(() => setError("Could not open the data folder."))
            }
          >
            <FolderOpen size={15} /> Open data folder
          </button>
          <p className="small muted">
            Fieldwork {preferences.version}
            {preferences.development
              ? " · Development copy (separate data)"
              : ""}
            . Installed apps do not automatically change when source files
            change; rebuild and replace the app to update it. Your local data
            stays in this folder.
          </p>
        </>
      )}
    </section>
  );
}
