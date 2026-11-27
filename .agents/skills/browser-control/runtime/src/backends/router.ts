/**
 * Routes each operation to a backend. The order comes from, first match wins:
 * 1. the daemon's own one-line `backends` file in its daemon dir (written by `extension disable`,
 *    removed by `extension enable`),
 * 2. `BROWSER_CONTROL_BACKENDS`,
 * 3. the one-line file `~/.config/browser-control/backends` (for example `extension,cdp` or `browse,cdp`).
 * Files are read on every call so the order can change without a restart. When none is set,
 * a paired extension defaults to `extension` alone; otherwise the default is `cdp` (v1 behavior).
 *
 * Rules:
 * - A target id with a backend prefix (`extension:12`, `browse:12`) always goes to that backend.
 * - Explicit CDP requests (`connect_browser` / `start <browser>`, a DevTools targetId without a
 *   backend prefix, or `select_target` of a DevTools target) always run on `cdp`, even when the
 *   order is `extension`. After an explicit start or select, untargeted calls stay on CDP and
 *   `list_targets` includes CDP targets until `clear_target` or `nav --browser <slug>`.
 * - Otherwise backends are tried in order. Fallback to `cdp` happens only when the effective
 *   order lists `cdp`. With `extension` alone, failures (`RESTRICTED_PAGE`, `BackendUnavailable`),
 *   unhandled ops, and browser-level ops refuse with `EXTENSION_ONLY` and never touch CDP.
 * - While a backend tab is selected, tab operations that backend can't run fail with a clear
 *   message instead of silently acting on a different (CDP) tab.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { OperationHandler } from "@agent-software/core";
import { isBrowserLevelMethod } from "../session";
import { BackendUnavailable, prefixOf, type Backend, type OpInput } from "./types";

export const CDP = "cdp";
const EXTENSION = "extension";
const HEX_64_RE = /^[0-9a-f]{64}$/i;

export const EXTENSION_ONLY_HINT =
  "CDP is used only when asked: run `start <browser>` or pass a DevTools targetId, or set BROWSER_CONTROL_BACKENDS=extension,cdp to allow fallback.";

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

// The bundled daemon and the capability it loads each hold a copy of this module, so shared
// process-wide handles live on global symbols that both copies read.
const DAEMON_BACKENDS_FILE = Symbol.for("browser-control.daemonBackendsFile");
const AUTO_CONNECT = Symbol.for("browser-control.autoConnect");
const shared = globalThis as unknown as Record<symbol, unknown>;

/** The daemon calls this once at startup with `<daemonDir>/backends`. */
export function setDaemonBackendsFile(file: string | undefined): void {
  shared[DAEMON_BACKENDS_FILE] = file;
}

function autoConnectStorage(): AsyncLocalStorage<boolean> {
  return (shared[AUTO_CONNECT] ??= new AsyncLocalStorage<boolean>()) as AsyncLocalStorage<boolean>;
}

/** Run an automatic reconnect so the router does not pin CDP as the explicit active route. */
export function withAutoConnect<T>(fn: () => T): T {
  return autoConnectStorage().run(true, fn);
}

function readOneLine(file: string): string {
  try {
    return readFileSync(file, "utf8").trim();
  } catch {
    return "";
  }
}

export type RelayTokenRead = { token: string } | { state: "missing" | "bad" };

export function defaultTokenFilePath(): string {
  const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(config, "browser-control", "extension-relay.json");
}

/** Read and validate a private (0600, owned by us) relay token file holding a 64-hex token. */
export function readPrivateTokenSync(tokenFile: string = defaultTokenFilePath()): RelayTokenRead {
  let info;
  try {
    info = statSync(tokenFile);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: "missing" };
    return { state: "bad" };
  }
  if ((info.mode & 0o077) !== 0 || (typeof process.getuid === "function" && info.uid !== process.getuid())) {
    return { state: "bad" };
  }
  try {
    const parsed = JSON.parse(readFileSync(tokenFile, "utf8")) as { token?: unknown };
    if (typeof parsed.token === "string" && HEX_64_RE.test(parsed.token)) {
      return { token: parsed.token.toLowerCase() };
    }
  } catch {
    /* unreadable or not JSON */
  }
  return { state: "bad" };
}

export function backendOrder(): string[] {
  const daemonBackendsFile = shared[DAEMON_BACKENDS_FILE] as string | undefined;
  let raw = daemonBackendsFile ? readOneLine(daemonBackendsFile) : "";
  if (!raw) raw = process.env["BROWSER_CONTROL_BACKENDS"]?.trim() ?? "";
  if (!raw) {
    const config = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
    raw = readOneLine(join(config, "browser-control", "backends"));
  }
  if (!raw) raw = "token" in readPrivateTokenSync() ? EXTENSION : CDP;
  const names = raw
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  return [...new Set(names)];
}

/** True when `error` is a `BackendUnavailable` (even across bundled module instances). */
export function isBackendUnavailable(error: unknown): error is Error {
  return error instanceof BackendUnavailable || (error instanceof Error && error.name === "BackendUnavailable");
}

/** True when `extension` is enabled without `cdp` in the effective backend order. */
export function isExtensionOnlyOrder(order: string[] = backendOrder()): boolean {
  return order.includes(EXTENSION) && !order.includes(CDP);
}

/** Format a stable `EXTENSION_ONLY:` refusal keeping the backend's reason plus the CDP opt-in. */
export function extensionOnlyMessage(reason: string | Error): string {
  const raw = (reason instanceof Error ? reason.message : reason)
    .replace(/^BACKEND_UNAVAILABLE:\s*extension:\s*/i, "")
    .trim()
    .replace(/\.+$/, "");
  return `EXTENSION_ONLY: ${raw || "the extension can't handle this request"}. ${EXTENSION_ONLY_HINT}`;
}

function unhandledExtensionReason(op: string, input: OpInput): string {
  if (op === "execute_cdp" && typeof input["method"] === "string" && isBrowserLevelMethod(input["method"])) {
    return `browser-level CDP method "${input["method"]}" can't run on the extension`;
  }
  return `${op} isn't handled by the extension`;
}

export function route(
  cdpOps: Record<string, OperationHandler>,
  backends: Backend[],
  order: () => string[] = backendOrder,
): Record<string, OperationHandler> {
  let active: string | undefined;
  let cdpUsed = false;
  const byName = new Map(backends.map((b) => [b.name, b]));
  const enabled = () => order().filter((n) => n === CDP || byName.has(n));

  async function invokeNamed(backend: Backend, op: string, input: OpInput, wrapExtensionOnly: boolean): Promise<unknown> {
    try {
      const result = await backend.invoke(op, input);
      active = backend.name;
      return result;
    } catch (error) {
      if (wrapExtensionOnly && isBackendUnavailable(error)) throw new Error(extensionOnlyMessage(error));
      throw error;
    }
  }

  async function runOp(op: string, input: OpInput): Promise<unknown> {
    const orderNow = enabled();
    const extensionOnly = isExtensionOnlyOrder(orderNow);
    // A backend removed from the order (`extension disable`) no longer owns untargeted calls.
    // An explicit CDP route (`start <browser>` / `select_target`) persists until cleared or switched.
    if (active !== undefined && active !== CDP && !orderNow.includes(active)) active = undefined;

    // `nav --browser <slug>` names an extension browser, whatever the backend order or target.
    if (op === "navigate" && typeof input["browser"] === "string") {
      const ext = orderNow.includes(EXTENSION) ? byName.get(EXTENSION) : undefined;
      if (!ext) throw new Error("INPUT_INVALID: --browser needs the extension backend enabled");
      return invokeNamed(ext, op, input, extensionOnly);
    }

    const prefix = prefixOf(input["targetId"]);
    if (prefix !== undefined && byName.has(prefix) && !orderNow.includes(prefix)) {
      throw new Error(
        prefix === EXTENSION
          ? "INPUT_INVALID: the extension backend is disabled; run: extension enable"
          : `INPUT_INVALID: the ${prefix} backend is disabled`,
      );
    }
    const named = prefix !== undefined ? byName.get(prefix) : undefined;
    if (named) {
      if (!named.handles(op, input, active === named.name)) {
        if (named.name === EXTENSION && extensionOnly) {
          throw new Error(extensionOnlyMessage(unhandledExtensionReason(op, input)));
        }
        throw new Error(`INPUT_INVALID: ${op} isn't available on ${named.name} tabs; use a DevTools tab for it`);
      }
      return invokeNamed(named, op, input, named.name === EXTENSION && extensionOnly);
    }

    // Explicit CDP by name works even when the effective order is `extension` alone:
    // - `connect_browser` (`start [browser|port]`),
    // - a DevTools targetId without a backend prefix (`select_target` or any targeted op),
    // - untargeted calls while an explicit CDP route is active (`active === CDP`).
    const rawTargetId =
      typeof input["targetId"] === "string" && input["targetId"].trim() !== "" ? input["targetId"] : undefined;
    const explicitCdpTarget = rawTargetId !== undefined && prefix === undefined;
    const explicitCdp =
      op === "connect_browser" ||
      explicitCdpTarget ||
      (active === CDP && input["targetId"] === undefined && input["browser"] === undefined);

    if (explicitCdp) {
      const handler = cdpOps[op];
      if (!handler) throw new Error(`OPERATION_NOT_FOUND: ${op}`);
      const result = await handler(input);
      cdpUsed = true;
      if ((op === "connect_browser" && !autoConnectStorage().getStore()) || op === "select_target") active = CDP;
      if (op === "disconnect_browser") active = undefined;
      return result;
    }

    if (extensionOnly) {
      if (op === "select_target" && !rawTargetId) throw new Error("INPUT_INVALID: targetId is required");
      if (op === "navigate" && (typeof input["url"] !== "string" || input["url"] === "")) {
        throw new Error("INPUT_INVALID: url is required");
      }
      if (op === "execute_cdp" && (typeof input["method"] !== "string" || input["method"] === "")) {
        throw new Error("INPUT_INVALID: method is required");
      }
    }

    const skipped: Error[] = [];
    for (let i = 0; i < orderNow.length; i++) {
      const name = orderNow[i]!;
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
        const result = await handler(input);
        cdpUsed = true;
        if (op === "select_target") active = CDP;
        return result;
      }
      const backend = byName.get(name)!;
      if (!backend.handles(op, input, active === name)) continue;
      try {
        const result = await backend.invoke(op, input);
        if (op === "select_target" || op === "navigate") active = name;
        return result;
      } catch (error) {
        // A named browser that is offline is an error, never a reason to use another tab.
        if (!isBackendUnavailable(error) || input["browser"] !== undefined) throw error;
        skipped.push(error);
        if (active === name && i < orderNow.length - 1) active = undefined;
      }
    }
    if (extensionOnly) {
      throw new Error(extensionOnlyMessage(skipped[0] ?? unhandledExtensionReason(op, input)));
    }
    const detail = skipped.length > 0 ? ` (${skipped.map((e) => e.message).join("; ")})` : "";
    throw new Error(`BACKEND_UNAVAILABLE: no enabled backend can run ${op}${detail}`);
  }

  const ops: Record<string, OperationHandler> = {};
  for (const op of Object.keys(cdpOps)) ops[op] = (input) => runOp(op, input);

  ops["clear_target"] = async (input) => {
    for (const b of backends) b.clearActive();
    active = undefined;
    if (enabled().includes(CDP) || cdpUsed) {
      return cdpOps["clear_target"]!(input);
    }
    return { activeTargetId: null, activeSessionId: null };
  };

  ops["list_targets"] = async (input) => {
    const orderNow = enabled();
    const extensionOnly = isExtensionOnlyOrder(orderNow);
    const includeCdp = orderNow.includes(CDP) || active === CDP;
    const names = includeCdp && !orderNow.includes(CDP) ? [...orderNow, CDP] : orderNow;
    const targets: unknown[] = [];
    const errors: string[] = [];
    let extensionError: Error | undefined;
    for (const name of names) {
      try {
        if (name === CDP) {
          const r = (await cdpOps["list_targets"]!(input)) as { targets: unknown[] };
          cdpUsed = true;
          targets.push(...r.targets);
        } else {
          targets.push(...(await byName.get(name)!.listTargets()));
        }
      } catch (error) {
        // Rethrow when CDP is alone or is the active route (so daemon auto-reconnect still fires).
        if (name === CDP && (names.length === 1 || active === CDP)) throw error;
        if (name === EXTENSION) extensionError = error as Error;
        errors.push(`${name}: ${(error as Error).message}`);
      }
    }
    if (extensionOnly && !includeCdp && targets.length === 0 && extensionError) {
      if (isBackendUnavailable(extensionError)) throw new Error(extensionOnlyMessage(extensionError));
      throw extensionError;
    }
    return errors.length > 0 ? { targets, errors } : { targets };
  };

  ops["get_browser_status"] = async (input) => {
    const orderNow = enabled();
    if (orderNow.length === 1 && orderNow[0] === CDP) {
      return cdpOps["get_browser_status"]!(input);
    }
    const base =
      orderNow.includes(CDP) || cdpUsed || active === CDP
        ? ((await cdpOps["get_browser_status"]!(input)) as Record<string, unknown>)
        : { connected: false, activeTargetId: null };
    const extra: Record<string, unknown> = {};
    for (const name of orderNow) {
      if (name !== CDP) extra[name] = await byName.get(name)!.status();
    }
    return { ...base, backends: { order: orderNow, active: active ?? null, ...extra } };
  };

  return ops;
}
