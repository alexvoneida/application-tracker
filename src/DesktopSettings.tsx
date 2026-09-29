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
        .catch(() => setError("couldn't load desktop settings"));
  }, [desktop]);
  if (!desktop) return null;
  return (
    <section className="settings-section">
      <div className="settings-title">
        <Monitor size={21} />
        <div>
          <h2>desktop app</h2>
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
              setError("couldn't save that, try again");
            } finally {
              setBusy(false);
            }
          }}
        />
        <span>
          keep running in the menu bar
          <small>
            closing the window keeps the links file and gmail sync going. ⌘Q
            actually quits. saves right away.
          </small>
        </span>
      </label>
      <p className="small muted">
        doesn't open at login or keep the mac awake. sync picks back up after
        the mac wakes.
      </p>
      {preferences && (
        <>
          <p className="small muted desktop-data-path">
            data: <code>{preferences.dataDirectory}/tracker.sqlite</code>
          </p>
          <button
            className="button secondary"
            onClick={() =>
              void desktop
                .openDataDirectory()
                .catch(() => setError("couldn't open the data folder"))
            }
          >
            <FolderOpen size={15} /> open data folder
          </button>
          <p className="small muted">
            v{preferences.version}
            {preferences.development ? " · dev copy (separate data)" : ""}.
            rebuild the dmg to update; data stays put.
          </p>
        </>
      )}
    </section>
  );
}
