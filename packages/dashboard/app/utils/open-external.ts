/*
FNXC:DesktopOAuth 2026-07-21-09:30:
Official Fusion v0.72.0 fixes desktop OAuth flows whose post-login await can
outlive Chromium user activation and silently block `window.open`. On desktop,
prefer the activation-free IPC bridge; on web, retain the browser fallback.
*/

interface DesktopShellApi {
  openExternal?: (url: string) => Promise<boolean>;
}

function desktopShellApi(): DesktopShellApi | undefined {
  const w = window as unknown as { fusionAPI?: DesktopShellApi; electronAPI?: DesktopShellApi };
  return w.fusionAPI ?? w.electronAPI;
}

/** Open a URL in the user's browser: desktop IPC when available, window.open otherwise. */
export function openExternalUrl(url: string): void {
  const api = desktopShellApi();
  if (typeof api?.openExternal === "function") {
    void api.openExternal(url).then((opened) => {
      if (!opened) window.open(url, "_blank");
    }).catch(() => {
      window.open(url, "_blank");
    });
    return;
  }
  window.open(url, "_blank");
}
