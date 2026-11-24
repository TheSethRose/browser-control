import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  RELOAD_TOOL_NAME,
  buildCapabilityToolDefinitions,
  openStandaloneCapability,
  type InvokeResult,
} from "@agent-software/core";

const browserControlDir = resolve(import.meta.dir, "..");
const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    await rm(roots.pop()!, { recursive: true, force: true });
  }
});

const EXPECTED_OPERATIONS = [
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
].sort();

/**
 * The exact tools the standalone MCP advertises, without a transport. The
 * generic MCP client behavior is covered in `core/tests/standalone.test.ts`.
 */
async function standaloneToolNames(capabilityDir: string): Promise<string[]> {
  const capability = await openStandaloneCapability(capabilityDir);
  try {
    return buildCapabilityToolDefinitions(capability)
      .map((tool) => tool.name)
      .sort();
  } finally {
    await capability.runtime.shutdown();
  }
}

async function invokeStandalone(capabilityDir: string, operation: string): Promise<InvokeResult> {
  const capability = await openStandaloneCapability(capabilityDir);
  try {
    return await capability.runtime.invoke(capability.name, operation, {});
  } finally {
    await capability.runtime.shutdown();
  }
}

/** Find a skill folder by frontmatter `name` anywhere under the skill root. */
async function findSkillDir(root: string, name: string): Promise<string> {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    const entries = await readdir(dir, { withFileTypes: true });
    if (entries.some((entry) => entry.isFile() && entry.name === "SKILL.md")) {
      const text = await readFile(join(dir, "SKILL.md"), "utf8");
      if (new RegExp(`^name:\\s*${name}\\s*$`, "m").test(text)) return dir;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) stack.push(join(dir, entry.name));
    }
  }
  throw new Error(`skill not found: ${name}`);
}

describe("browser-control standalone delivery", () => {
  test("standalone MCP exposes only browser-control's operations, with plain names", async () => {
    const names = await standaloneToolNames(browserControlDir);

    expect(names).toEqual(EXPECTED_OPERATIONS);
    expect(names).not.toContain("browser-control__list_browsers");
    expect(names).not.toContain("example_operation");
    expect(names).not.toContain(RELOAD_TOOL_NAME);

    const status = await invokeStandalone(browserControlDir, "get_browser_status");
    expect(status.ok).toBe(true);
  });

  test("named standalone CLI runs the shared implementation", async () => {
    const cliPath = join(browserControlDir, "cli.ts");

    const listProc = Bun.spawn(["bun", cliPath, "--list"], { stdout: "pipe", stderr: "pipe" });
    const listOut = await new Response(listProc.stdout).text();
    expect(await listProc.exited).toBe(0);
    const listed = JSON.parse(listOut) as Array<{ operation: string }>;
    expect(listed.map((operation) => operation.operation).sort()).toEqual(EXPECTED_OPERATIONS);

    const callProc = Bun.spawn(["bun", cliPath, "list_browsers"], { stdout: "pipe", stderr: "pipe" });
    const callOut = await new Response(callProc.stdout).text();
    expect(await callProc.exited).toBe(0);
    const result = JSON.parse(callOut) as { ok: boolean; data: { browsers: unknown } };
    expect(result.ok).toBe(true);
    expect(Array.isArray(result.data.browsers)).toBe(true);
  });

  test("the browser-control skill does not depend on the aggregate MCP", async () => {
    // The skill may live alongside the project or in a sibling repo's skill root.
    const skillRoot = findSkillRoot(browserControlDir);
    if (!skillRoot) return; // no skill root reachable from here
    const skillDir = await findSkillDir(skillRoot, "browser-control");
    const referencesDir = join(skillDir, "references");
    const references = (await readdir(referencesDir)).map((file) => join(referencesDir, file));
    const files = [join(skillDir, "SKILL.md"), ...references];

    for (const file of files) {
      const text = await readFile(file, "utf8");
      expect(text).not.toContain("browser-control__");
    }
  });

  test("removing another capability does not affect browser-control's standalone MCP", async () => {
    const root = await mkdtemp(join(tmpdir(), "bc-standalone-"));
    roots.push(root);
    const parent = join(root, "capabilities");
    const target = join(parent, "browser-control");
    await cp(browserControlDir, target, {
      recursive: true,
      filter: (source) => basename(source) !== "node_modules" && basename(source) !== ".git",
    });

    const otherDir = join(parent, "other");
    await mkdir(otherDir, { recursive: true });
    await writeFile(
      join(otherDir, "capability.json"),
      JSON.stringify({
        name: "other",
        version: "0.1.0",
        description: "Sibling capability",
        entrypoint: "src-index.ts",
        operations: [{ name: "ping", description: "Pings" }],
      }),
    );
    await writeFile(join(otherDir, "src-index.ts"), `export const operations = { ping: async () => ({ pong: true }) };`);

    const before = await standaloneToolNames(target);
    await rm(otherDir, { recursive: true, force: true });
    const after = await standaloneToolNames(target);

    expect(before).toEqual(EXPECTED_OPERATIONS);
    expect(after).toEqual(before);
  });
});

/** Walk up from `start` looking for a `.agents/skills` directory. */
function findSkillRoot(start: string): string | null {
  let dir = resolve(start);
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, ".agents", "skills");
    if (existsSync(candidate)) return candidate;
    const parent = resolve(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}
