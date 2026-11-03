/**
 * Platform detection for the shared Tauri UI.
 *
 * The same React bundle ships to Windows and Android, so a handful of worker
 * controls (compute backend, host firewall policy) need to reflect the platform
 * they are running on. Tauri's Android WebView always reports "Android" in its
 * user agent, which is sufficient and avoids pulling in an OS plugin.
 */
export const isAndroid =
  typeof navigator !== "undefined" && /Android/i.test(navigator.userAgent);

export const isDesktop = !isAndroid;
