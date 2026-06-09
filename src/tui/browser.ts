/**
 * Open a URL in the user's default browser via the platform opener. Detached
 * and best-effort: a missing opener (e.g. headless box) is silently ignored.
 */

export function openInBrowser(url: string): void {
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    const child = Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
    child.unref();
  } catch {
    /* no opener available — ignore */
  }
}
