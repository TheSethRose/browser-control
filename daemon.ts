// Long-lived Unix-socket server for one capability runtime, so one CDP connection (and one
// Chrome "Allow" prompt) serves many short client calls. `scripts/browser-control-daemon` is
// the curl-based client.
//
//   POST /call/<operation>   JSON object body -> InvokeResult JSON (HTTP 400 when ok:false)
//   POST /eval               JavaScript body  -> the value as text
//   POST /nav                URL body         -> navigate result as text (?until=load&snap=1)
//   POST /page/<action>      JSON body        -> page helper result as text
//        actions: snap, text, form, query, read-urls, click, type, select, upload, drag,
//                 wait, key, value, ocr, do, shot, verdict, health, styles, issues, perf,
//                 notes, flow, script
//   GET  /tabs               one page per line, "*" marks the active target
//   GET  /ops                one operation per line with its input names
//   GET  /status             daemon pid, version, build hash + get_browser_status
//   POST /stop               dispose and exit
//
// /eval, /nav and /page/* take ?t=<targetId> or ?m=<text in the tab's url or title>,
// ?q=1 to leave out the "what changed" lines after an action, and ?raw=1 to omit untrusted boundaries.
import { openStandaloneCapability, type InvokeResult } from "@agent-software/core";
import { createHash } from "node:crypto";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { disposeOcr } from "./src/ocr";
import { createPageHelperHandler, formatAxTree, matchTab } from "./src/page-runner";
import { imageWidth } from "./src/picture";
import { escapeControls, withRemedy, wrapUntrusted } from "./src/safety";

export { createPageHelperHandler, formatAxTree, imageWidth, matchTab };

type Json = Record<string, unknown>;

const UNTRUSTED_PAGE_ACTIONS = new Set([
  "snap", "text", "form", "query", "read-urls", "ocr", "value", "verdict", "health",
  "styles", "issues", "perf", "click", "type", "select", "upload", "drag", "wait", "key", "do",
  "notes", "flow", "script",
]);

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;

/** Strings print bare; everything else prints as JSON. Control characters are escaped. */
function asText(value: unknown, maxChars: number, untrusted: boolean): string {
  const raw = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
  const clipped = raw.length <= maxChars
    ? raw
    : `${raw.slice(0, maxChars)}\n[truncated ${raw.length - maxChars} of ${raw.length} chars; narrow the expression or raise BROWSER_CONTROL_MAX_OUTPUT]`;
  return untrusted ? wrapUntrusted(clipped) : escapeControls(clipped);
}

/** Short SHA-256 fingerprint of the running script so the client can detect a stale daemon build. */
export function buildHash(scriptPath: string | undefined): string {
  if (!scriptPath) return "unknown";
  try {
    return createHash("sha256").update(readFileSync(scriptPath)).digest("hex").slice(0, 12);
  } catch {
    return "unknown";
  }
}

function readVersion(capabilityDir: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(capabilityDir, "capability.json"), "utf8")) as { version?: string };
    return typeof manifest.version === "string" ? manifest.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export async function serveDaemon(capabilityDir: string, socketPath: string): Promise<void> {
  const capability = await openStandaloneCapability(capabilityDir);
  const maxChars = Number(process.env["BROWSER_CONTROL_MAX_OUTPUT"]) || 50_000;
  const boundariesDefault = process.env["BROWSER_CONTROL_CONTENT_BOUNDARIES"] !== "0";
  const build = buildHash(process.argv[1]);
  const version = readVersion(capabilityDir);
  const buildFile = `${socketPath}.build`;

  try {
    writeFileSync(buildFile, `${build}\n`);
  } catch {
    /* non-fatal: /status still exposes build */
  }

  const invokeOnce = async (operation: string, input: Json): Promise<InvokeResult> => {
    try {
      return await capability.runtime.invoke(capability.name, operation, input);
    } catch (error) {
      return failure("EXECUTION_FAILED", (error as Error).message);
    }
  };

  let reconnectInput: Json = { timeoutMs: 60_000 };

  /** Invoke; if there is no browser connection (never made, or dropped), connect once and retry. */
  const invoke = async (operation: string, input: Json = {}): Promise<InvokeResult> => {
    if (operation === "disconnect_browser") {
      return failure(
        "EXECUTION_FAILED",
        "DISCONNECT_REFUSED: the daemon keeps browser connections so the user is not asked to click Allow again. Disconnecting fixes nothing. Only if the user asked: browser-control-daemon stop --force",
      );
    }
    const result = await invokeOnce(operation, input);
    if (operation === "connect_browser") {
      if (result.ok) {
        const { port: _port, wsUrl: _wsUrl, ...rest } = input;
        const name = ((result.data as Json)["via"] as Json | undefined)?.["name"];
        reconnectInput = typeof name === "string" && !rest["browser"] && !rest["profileDir"] ? { ...rest, browser: name } : rest;
      }
      return result;
    }
    if (result.ok || !result.error.message.startsWith("NOT_CONNECTED")) return result;
    const reconnected = await invokeOnce("connect_browser", reconnectInput);
    return reconnected.ok ? invokeOnce(operation, input) : reconnected;
  };

  const handlePage = createPageHelperHandler(invoke);

  const json = (result: InvokeResult) => {
    const out = result.ok ? result : failure(result.error.code, escapeControls(withRemedy(result.error.message)));
    return new Response(`${JSON.stringify(out)}\n`, { status: result.ok ? 200 : 400 });
  };

  /** Text reply: `pick(data)` on success, the error JSON on failure. */
  const text = (result: InvokeResult, pick: (data: any) => unknown, untrusted = false) =>
    result.ok ? new Response(`${asText(pick(result.data), maxChars, untrusted)}\n`) : json(result);

  const parseJsonBody = (raw: string): { ok: true; value: Json } | { ok: false; res: Response } => {
    if (raw === "") return { ok: true, value: {} };
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      return { ok: false, res: json(failure("INPUT_VALIDATION_FAILED", `invalid JSON input: ${(error as Error).message}`)) };
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { ok: false, res: json(failure("INPUT_VALIDATION_FAILED", "input must be a JSON object")) };
    }
    return { ok: true, value: parsed as Json };
  };

  const stop = async () => {
    disposeOcr();
    await capability.runtime.shutdown().catch(() => {});
    rmSync(socketPath, { force: true });
    rmSync(buildFile, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  Bun.serve({
    unix: socketPath,
    idleTimeout: 0,
    async fetch(request: Request) {
      const url = new URL(request.url);
      const [route, operation] = url.pathname.slice(1).split("/");
      const started = performance.now();
      const reply = await respond(request, url, route ?? "", operation ?? "");
      if (route !== "status") {
        console.log(`${new Date().toISOString()} ${Math.round(performance.now() - started)}ms ${reply.status} /${route}${operation ? `/${operation}` : ""}`);
      }
      return reply;
    },
  } as unknown as Parameters<typeof Bun.serve>[0]);

  async function respond(request: Request, url: URL, route: string, operation: string): Promise<Response> {
    let targetId = url.searchParams.get("t") || undefined;
    const body = (await request.text()).trim();
    const match = url.searchParams.get("m");
    if (match && !targetId) {
      const tab = await matchTab(invoke, match);
      if (!tab.ok) return json(tab.res);
      targetId = tab.targetId;
    }
    const quiet = url.searchParams.get("q") === "1";
    const wrap = boundariesDefault && url.searchParams.get("raw") !== "1";

    switch (route) {
      case "call": {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return parsed.res;
        return json(await invoke(operation, parsed.value));
      }
      case "eval":
        return text(await invoke("evaluate", { expression: body, targetId }), (data) => data.value, wrap);
      case "nav":
        return text(
          await handlePage(
            "nav",
            { url: body, until: url.searchParams.get("until") ?? "", snap: url.searchParams.get("snap") === "1" },
            targetId,
          ),
          (data) => data.value,
          wrap,
        );
      case "page": {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) return parsed.res;
        const shouldWrap = wrap && UNTRUSTED_PAGE_ACTIONS.has(operation) && !parsed.value["out"];
        return text(
          await handlePage(operation, { ...parsed.value, ...(quiet ? { quiet: true } : {}) }, targetId),
          (data) => data.value,
          shouldWrap,
        );
      }
      case "tabs": {
        const [targets, status] = await Promise.all([
          invoke("list_targets", { types: ["page"] }),
          invoke("get_browser_status"),
        ]);
        const state = status.ok ? (status.data as Json) : {};
        const active = state["activeTargetId"];
        const others = (state["alsoConnected"] as string[] | undefined) ?? [];
        const header = `# ${state["browser"] ?? "browser"}${others.length > 0 ? ` (also connected: ${others.join(", ")}; switch with: start <name>)` : ""}`;
        return text(
          targets,
          (data) =>
            [
              header,
              ...(data.targets as Array<{ targetId: string; url: string; title: string }>).map(
                (t) => `${t.targetId === active ? "*" : " "} ${t.targetId} ${t.url.slice(0, 100)} | ${t.title.slice(0, 60)}`,
              ),
            ].join("\n"),
          wrap,
        );
      }
      case "ops":
        return new Response(
          `${capability.runtime
            .listOperations(capability.name)
            .map((o) => {
              const schema = capability.runtime.getOperationInputSchema(capability.name, o.operation);
              const names = Object.keys((schema?.["properties"] as Json | undefined) ?? {});
              return `${o.operation}(${names.join(", ")}) — ${o.description}`;
            })
            .join("\n")}\n`,
        );
      case "status": {
        const status = await invoke("get_browser_status");
        return json(
          status.ok ? { ok: true, data: { running: true, pid: process.pid, version, build, ...(status.data as Json) } } : status,
        );
      }
      case "stop":
        setTimeout(stop, 10);
        return json({ ok: true, data: { running: false } });
      default:
        return json(failure("OPERATION_NOT_FOUND", `unknown daemon route: /${route}`));
    }
  }
}
