/**
 * The `browse` backend: drives the browser through opencode's browse extension
 * (https://opencode.ai/product/browse) by calling its `browse` CLI.
 *
 * It needs no remote-debugging port and no per-connection "Allow" click, and its tabs open
 * in the background. It only sees tabs it opened or the user lent it, and it has no raw CDP
 * access, so it covers a subset of operations: everything else falls back to CDP.
 *
 * Talking to the CLI (not its relay API) keeps this file the only thing that changes when
 * browse changes. Remove the backend by deleting this file and its line in `./registry`.
 */

import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { randomUUID } from "node:crypto";
import { BackendUnavailable, prefixOf, type Backend, type BackendTarget, type OpInput } from "./types";

const NAME = "browse";
const OPS = new Set(["navigate", "evaluate", "capture_screenshot", "select_target"]);

export type RunResult = { code: number; stdout: string; stderr: string };
export type Runner = (args: string[], timeoutMs: number) => Promise<RunResult>;

/** Run `browse <args>`; a missing executable is reported as code 127. */
export const runBrowse: Runner = async (args, timeoutMs) => {
  const bin = process.env["BROWSE_BIN"] || "browse";
  let proc;
  try {
    proc = Bun.spawn([bin, ...args], { cwd: tmpdir(), stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    return { code: 127, stdout: "", stderr: `${bin} not found` };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
};

const id = (tab: number) => `${NAME}:${tab}`;

function tabOf(targetId: unknown): number | undefined {
  if (prefixOf(targetId) !== NAME) return undefined;
  const n = Number((targetId as string).slice(NAME.length + 1));
  return Number.isInteger(n) ? n : undefined;
}

/** Messages that mean "browse can't serve this now", as opposed to a real failure. */
const UNAVAILABLE = /no (connected )?browser|browser is not connected|relay (is )?not|ECONNREFUSED|not paired/i;

export function createBrowseBackend(run: Runner = runBrowse): Backend {
  let active: number | undefined;

  async function tool(name: string, args: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    const r = await run([name, "--json", JSON.stringify(args)], timeoutMs + 5_000);
    const text = r.stdout || r.stderr;
    if (r.code === 127) throw new BackendUnavailable(NAME, "the browse CLI is not installed");
    if (r.code !== 0) {
      if (UNAVAILABLE.test(text) && !/of the eval code/.test(text)) throw new BackendUnavailable(NAME, text);
      throw new Error(text || `browse ${name} failed (exit ${r.code})`);
    }
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  function tabFor(input: OpInput): number | undefined {
    return tabOf(input["targetId"]) ?? active;
  }

  return {
    name: NAME,

    handles(op, input, isActive) {
      if (!OPS.has(op)) return false;
      // Let CDP's input validation report a missing url.
      if (op === "navigate" && (typeof input["url"] !== "string" || input["url"] === "")) return false;
      if (op === "select_target") return tabOf(input["targetId"]) !== undefined;
      if (tabOf(input["targetId"]) !== undefined) return true;
      if (input["targetId"] !== undefined) return false; // a CDP tab
      // navigate with no tab opens a new browse tab; the others need a browse tab selected.
      return op === "navigate" ? isActive || active === undefined : isActive && active !== undefined;
    },

    async invoke(op, input) {
      const timeoutMs = typeof input["timeoutMs"] === "number" ? input["timeoutMs"] : undefined;
      switch (op) {
        case "select_target": {
          active = tabOf(input["targetId"]);
          return { activeTargetId: input["targetId"], backend: NAME };
        }

        case "navigate": {
          const tab = tabFor(input);
          const args: Record<string, unknown> = { url: input["url"] };
          if (tab !== undefined) args["tab"] = tab;
          if (timeoutMs !== undefined) args["timeout"] = timeoutMs;
          const r = (await tool("navigate", args, timeoutMs)) as {
            tab?: number;
            url?: string;
            title?: string;
            status?: number;
            pending?: boolean;
            challenge?: unknown;
            warning?: string;
          };
          const t = r.tab ?? tab;
          if (t !== undefined) active = t;
          const out: Record<string, unknown> = {
            loaded: r.pending !== true,
            targetId: t === undefined ? null : id(t),
            url: r.url,
            title: r.title,
            backend: NAME,
          };
          if (r.status !== undefined) out["status"] = r.status;
          if (r.challenge !== undefined) out["challenge"] = r.challenge;
          if (r.warning) out["warning"] = r.warning;
          return out;
        }

        case "evaluate": {
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no browse tab selected");
          // "main" matches CDP's Runtime.evaluate: the page's own globals are visible.
          const args: Record<string, unknown> = { tab, expression: input["expression"], world: "main" };
          if (timeoutMs !== undefined) args["timeout"] = timeoutMs;
          try {
            return { value: await tool("eval", args, timeoutMs) };
          } catch (error) {
            const msg = (error as Error).message;
            if (/of the eval code|^\w*Error:/.test(msg)) throw new Error(`JS_EXCEPTION: ${msg.slice(0, 600)}`);
            throw error;
          }
        }

        case "capture_screenshot": {
          const tab = tabFor(input);
          if (tab === undefined) throw new BackendUnavailable(NAME, "no browse tab selected");
          const format = input["format"] === "jpeg" ? "jpeg" : "png";
          const ext = format === "jpeg" ? "jpg" : "png";
          const dir = process.env["BROWSER_ARTIFACT_DIR"]?.trim() || join(tmpdir(), "browser-control");
          const path =
            typeof input["path"] === "string"
              ? resolvePath(input["path"])
              : join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}.${ext}`);
          const args: Record<string, unknown> = { tab, format, path };
          if (typeof input["quality"] === "number") args["quality"] = input["quality"];
          if (input["fullPage"] === true) args["fullPage"] = true;
          if (input["clip"] !== undefined) args["clip"] = input["clip"];
          const r = (await tool("screenshot", args)) as { path?: string; width?: number; height?: number };
          const saved = r.path ?? path;
          const bytes = await stat(saved).then((s) => s.size).catch(() => undefined);
          return {
            path: saved,
            mimeType: format === "jpeg" ? "image/jpeg" : "image/png",
            ...(bytes !== undefined ? { bytes } : {}),
            ...(r.width !== undefined ? { width: r.width, height: r.height } : {}),
            targetId: id(tab),
            backend: NAME,
          };
        }
      }
      throw new BackendUnavailable(NAME, `${op} is not supported`);
    },

    async listTargets(): Promise<BackendTarget[]> {
      const r = (await tool("tabs", { action: "list" }, 15_000)) as {
        tabs?: Array<{ tab: number; url?: string; title?: string }>;
      };
      return (r.tabs ?? []).map((t) => ({
        targetId: id(t.tab),
        type: "page",
        title: t.title ?? "",
        url: t.url ?? "",
        backend: NAME,
      }));
    },

    async status() {
      try {
        const tabs = await this.listTargets();
        return { available: true, tabs: tabs.length, activeTargetId: active === undefined ? null : id(active) };
      } catch (error) {
        return { available: false, reason: (error as Error).message };
      }
    },

    clearActive() {
      active = undefined;
    },
  };
}
