import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { validateInput, validateManifest, type CapabilityManifest } from "@agent-software/core";

const manifestPath = join(import.meta.dir, "../capability.json");

async function loadManifest(): Promise<CapabilityManifest> {
  return JSON.parse(await readFile(manifestPath, "utf8")) as CapabilityManifest;
}

describe("browser-control manifest", () => {
  test("is valid", async () => {
    const { valid, errors } = validateManifest(await loadManifest());
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
  });

  test("declares the expected operations and lifecycle-compatible config/state", async () => {
    const manifest = await loadManifest();
    expect(manifest.name).toBe("browser-control");
    expect(manifest.operations.map((o) => o.name).sort()).toEqual(
      [
        "capture_pdf",
        "capture_screenshot",
        "clear_target",
        "connect_browser",
        "disconnect_browser",
        "evaluate",
        "execute_cdp",
        "get_browser_status",
        "list_browsers",
        "list_targets",
        "navigate",
        "read_events",
        "select_target",
        "wait_for_event",
      ].sort(),
    );
    expect(manifest.config?.requiredEnv).toEqual([]);
    expect(manifest.state?.kind).toBe("external-service");
    expect(manifest.delivery).toEqual({ cli: true, mcp: true });
  });

  test("execute_cdp rejects malformed method names at the schema layer", async () => {
    const manifest = await loadManifest();
    const schema = manifest.operations.find((o) => o.name === "execute_cdp")?.inputs;
    expect(validateInput(schema, { method: "Page.navigate" })).toBeNull();
    expect(validateInput(schema, { method: "navigate" })).not.toBeNull();
    expect(validateInput(schema, { method: "" })).not.toBeNull();
    expect(validateInput(schema, {})).not.toBeNull();
  });

  test("select_target and wait_for_event require their key inputs", async () => {
    const manifest = await loadManifest();
    const select = manifest.operations.find((o) => o.name === "select_target")?.inputs;
    const wait = manifest.operations.find((o) => o.name === "wait_for_event")?.inputs;
    expect(validateInput(select, {})).not.toBeNull();
    expect(validateInput(select, { targetId: "abc" })).toBeNull();
    expect(validateInput(wait, {})).not.toBeNull();
    expect(validateInput(wait, { method: "Page.loadEventFired" })).toBeNull();
  });
});
