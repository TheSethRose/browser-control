/**
 * Routes each operation to a backend. The order comes from `BROWSER_CONTROL_BACKENDS` or the
 * one-line file `~/.config/browser-control/backends` (for example `browse,cdp`), read on
 * every call so it can change without a restart. The default is `cdp` alone, which is the
 * runtime's original behavior.
 *
 * Rules:
 * - A target id with a backend prefix (`browse:12`) always goes to that backend.
 * - Otherwise backends are tried in order; one that doesn't handle the operation, or throws
 *   `BackendUnavailable`, passes it on. `cdp` handles everything it declares.
 * - While a backend tab is selected, tab operations that backend can't run fail with a clear
 *   message instead of silently acting on a different (CDP) tab.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OperationHandler } from "@agent-software/core";
import { isBrowserLevelMethod } from "../session";
import { BackendUnavailable, prefixOf, type Backend, type OpInput } from "./types";

export const CDP = "cdp";

/** Operations that act on one tab. */
const TAB_OPS = new Set([
  "evaluate",
  "navigate",
  "capture_screenshot",
  "capture_pdf",
  "execute_cdp",
  "read_events",
  "wait_for_event",
]);

export function backendOrder(): string[] {
  let raw = process.env["BROWSER_CONTROL_BACKENDS"]?.trim();
  if (!raw) {
    const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
    try {
      raw = readFileSync(join(config, "browser-control", "backends"), "utf8").trim();
    } catch {
      raw = "";
    }
  }
  const names = (raw || CDP)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

export function route(
  cdpOps: Record<string, OperationHandler>,
  backends: Backend[],
  order: () => string[] = backendOrder,
): Record<string, OperationHandler> {
  let active: string | undefined;
  const byName = new Map(backends.map((b) => [b.name, b]));
  const enabled = () => order().filter((n) => n === CDP || byName.has(n));
  const enabledBackends = () => enabled().flatMap((n) => (n === CDP ? [] : [byName.get(n)!]));

  async function runOp(op: string, input: OpInput): Promise<unknown> {
    const prefix = prefixOf(input["targetId"]);
    const named = prefix !== undefined && enabled().includes(prefix) ? byName.get(prefix) : undefined;
    if (named) {
      if (!named.handles(op, input, active === named.name)) {
        throw new Error(`INPUT_INVALID: ${op} isn't available on ${named.name} tabs; use a DevTools tab for it`);
      }
      const result = await named.invoke(op, input);
      active = named.name;
      return result;
    }

    const skipped: string[] = [];
    for (const name of enabled()) {
      if (name === CDP) {
        const activeBackend = active && active !== CDP ? active : undefined;
        const method = input["method"];
        const browserLevel = op === "execute_cdp" && typeof method === "string" && isBrowserLevelMethod(method);
        if (activeBackend && TAB_OPS.has(op) && input["targetId"] === undefined && !browserLevel) {
          throw new Error(
            `INPUT_INVALID: ${op} isn't available on ${activeBackend} tabs; pass a DevTools targetId or select one first`,
          );
        }
        const handler = cdpOps[op];
        if (!handler) break;
        if (op === "select_target") active = CDP;
        return handler(input);
      }
      // A selected DevTools tab keeps untargeted calls (`nav <url>`) on that tab,
      // unless the call names a browser (`nav --browser <slug>`).
      if (active === CDP && input["targetId"] === undefined && input["browser"] === undefined) continue;
      const backend = byName.get(name)!;
      if (!backend.handles(op, input, active === name)) continue;
      try {
        const result = await backend.invoke(op, input);
        if (op === "select_target" || op === "navigate") active = name;
        return result;
      } catch (error) {
        if (!(error instanceof BackendUnavailable)) throw error;
        skipped.push(error.message);
        if (active === name) active = undefined;
      }
    }
    const detail = skipped.length > 0 ? ` (${skipped.join("; ")})` : "";
    throw new Error(`BACKEND_UNAVAILABLE: no enabled backend can run ${op}${detail}`);
  }

  const ops: Record<string, OperationHandler> = {};
  for (const op of Object.keys(cdpOps)) ops[op] = (input) => runOp(op, input);

  ops["clear_target"] = async (input) => {
    for (const b of backends) b.clearActive();
    active = undefined;
    return cdpOps["clear_target"]!(input);
  };

  ops["list_targets"] = async (input) => {
    const targets: unknown[] = [];
    const errors: string[] = [];
    for (const name of enabled()) {
      try {
        if (name === CDP) {
          const r = (await cdpOps["list_targets"]!(input)) as { targets: unknown[] };
          targets.push(...r.targets);
        } else {
          targets.push(...(await byName.get(name)!.listTargets()));
        }
      } catch (error) {
        // CDP failing alone keeps its own error; with other backends answering, report it.
        if (name === CDP && enabled().length === 1) throw error;
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }
    return errors.length > 0 ? { targets, errors } : { targets };
  };

  ops["get_browser_status"] = async (input) => {
    const base = (await cdpOps["get_browser_status"]!(input)) as Record<string, unknown>;
    const order = enabled();
    if (order.length === 1 && order[0] === CDP) return base;
    const extra: Record<string, unknown> = {};
    for (const b of enabledBackends()) extra[b.name] = await b.status();
    return { ...base, backends: { order, active: active ?? null, ...extra } };
  };

  return ops;
}
