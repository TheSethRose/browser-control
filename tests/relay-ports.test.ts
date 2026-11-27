// Relay port override (`BROWSER_CONTROL_RELAY_PORTS`) and the e2e extension port patch.
import { afterEach, describe, expect, it } from "bun:test";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { RELAY_PORTS_ENV as SRC_RELAY_PORTS_ENV, relayPortRangeFromEnv } from "../src/backends/extension";
import { E2E_PORT_END, E2E_PORT_START, patchExtensionPorts, pickRelayPort, RELAY_PORTS_ENV } from "./e2e/relay-port";

const REPO = resolve(import.meta.dir, "..");
const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length > 0) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function copyExtension(): string {
  const dir = mkdtempSync(join(tmpdir(), "bc-relay-ports-"));
  tempDirs.push(dir);
  cpSync(join(REPO, "extension"), dir, { recursive: true, filter: (p) => !p.endsWith("pairing.json") });
  return dir;
}

describe("relayPortRangeFromEnv", () => {
  it("parses a start-end window", () => {
    expect(relayPortRangeFromEnv({ [SRC_RELAY_PORTS_ENV]: "49610-49619" })).toEqual({ start: 49610, end: 49619 });
    expect(relayPortRangeFromEnv({ [SRC_RELAY_PORTS_ENV]: "49610-49610" })).toEqual({ start: 49610, end: 49610 });
    expect(relayPortRangeFromEnv({ [SRC_RELAY_PORTS_ENV]: " 1024-65535 " })).toEqual({ start: 1024, end: 65535 });
  });

  it("ignores a malformed or out-of-range value", () => {
    for (const raw of ["", "49610", "49610-", "-49619", "a-b", "49610..49619", "49619-49610", "80-90", "65535-65536", "0-10"]) {
      expect(relayPortRangeFromEnv({ [SRC_RELAY_PORTS_ENV]: raw })).toBeUndefined();
    }
    expect(relayPortRangeFromEnv({})).toBeUndefined();
  });

  it("uses the same variable on both sides", () => {
    expect(RELAY_PORTS_ENV).toBe(SRC_RELAY_PORTS_ENV);
  });
});

describe("e2e relay port window", () => {
  it("sits outside the live 49222-49229 range", () => {
    expect(E2E_PORT_START).toBeGreaterThan(49229);
    expect(E2E_PORT_END).toBeGreaterThanOrEqual(E2E_PORT_START);
  });

  it("picks a free port in the window", async () => {
    const port = await pickRelayPort();
    expect(port).toBeGreaterThanOrEqual(E2E_PORT_START);
    expect(port).toBeLessThanOrEqual(E2E_PORT_END);
  });
});

describe("patchExtensionPorts", () => {
  it("patches a copied background.js to one isolated port and leaves no live port behind", () => {
    const dir = copyExtension();
    const result = patchExtensionPorts(dir, 49610);
    expect(result.ok).toBe(true);
    const bg = readFileSync(join(dir, "background.js"), "utf8");
    expect(bg).toContain("const DEFAULT_PORT = 49610;");
    expect(bg).toContain("const PORT_RANGE_START = 49610;");
    expect(bg).toContain("const PORT_RANGE_END = 49610;");
    expect(/\b4922[2-9]\b/.test(bg.replace(/\/\/[^\n]*/g, ""))).toBe(false);
  });

  it("refuses to patch to a live relay port or an invalid one", () => {
    const dir = copyExtension();
    const before = readFileSync(join(dir, "background.js"), "utf8");
    for (const port of [49222, 49229, 80, 70000, 49610.5]) {
      expect(patchExtensionPorts(dir, port).ok).toBe(false);
    }
    expect(readFileSync(join(dir, "background.js"), "utf8")).toBe(before);
  });
});
