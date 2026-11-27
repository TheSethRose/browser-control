// Shared e2e relay-port isolation: the isolated port window and the copied extension's port patch.
// A test extension must never probe 49222-49229, where the user's live daemon may be listening.
import { readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";

/** Isolated e2e relay window, outside the 49222-49229 default a live daemon may hold. */
export const E2E_PORT_START = 49610;
export const E2E_PORT_END = 49619;
/** Same variable `src/backends/extension.ts` reads for the daemon's bind range. */
export const RELAY_PORTS_ENV = "BROWSER_CONTROL_RELAY_PORTS";

const LIVE_PORT_RE = /\b4922[2-9]\b/;
const isLivePort = (port: number) => port >= 49222 && port <= 49229;

/** First free loopback port in the isolated window, so the daemon binds exactly the patched port. */
export async function pickRelayPort(start = E2E_PORT_START, end = E2E_PORT_END): Promise<number | undefined> {
  for (let port = start; port <= end; port++) {
    const free = await new Promise<boolean>((resolve) => {
      const probe = createServer();
      probe.once("error", () => resolve(false));
      probe.once("listening", () => probe.close(() => resolve(true)));
      probe.listen({ host: "127.0.0.1", port });
    });
    if (free) return port;
  }
  return undefined;
}

/**
 * Rewrite a copied extension's background.js so it scans only `port`, then prove no 49222-49229
 * literal survives outside comments. Same three regexes and leak check as the stale build check.
 */
export function patchExtensionPorts(extensionDir: string, port: number): { ok: boolean; detail: string } {
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || isLivePort(port)) {
    return { ok: false, detail: `refusing to patch the extension to port ${port}` };
  }
  const bgPath = join(extensionDir, "background.js");
  let patchedBg = readFileSync(bgPath, "utf8");
  const patchRules: Array<[RegExp, string]> = [
    [/\bconst DEFAULT_PORT = 49222;/, `const DEFAULT_PORT = ${port};`],
    [/\bconst PORT_RANGE_START = 49222;/, `const PORT_RANGE_START = ${port};`],
    [/\bconst PORT_RANGE_END = 49229;/, `const PORT_RANGE_END = ${port};`],
  ];
  const missingPatches: string[] = [];
  for (const [re, rep] of patchRules) {
    if (!re.test(patchedBg)) missingPatches.push(re.source);
    else patchedBg = patchedBg.replace(re, rep);
  }
  const leakedDefaultPort = LIVE_PORT_RE.test(patchedBg.replace(/\/\/[^\n]*/g, ""));
  const ok =
    missingPatches.length === 0 &&
    !leakedDefaultPort &&
    patchedBg.includes(`const DEFAULT_PORT = ${port};`) &&
    patchedBg.includes(`const PORT_RANGE_START = ${port};`) &&
    patchedBg.includes(`const PORT_RANGE_END = ${port};`);
  if (ok) writeFileSync(bgPath, patchedBg, "utf8");
  return {
    ok,
    detail: ok
      ? `patched background.js to port ${port} only`
      : `failed to isolate port range (missing=${missingPatches.join(",")}, leaked=${leakedDefaultPort})`,
  };
}
