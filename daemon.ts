// Long-lived server for one capability runtime, so one CDP connection (and one
// Chrome "Allow" prompt) serves many short client calls. It listens on a Unix
// socket; `scripts/browser-control-daemon` is the curl-based client.
//
//   POST /call/<operation>   JSON object body -> InvokeResult JSON (HTTP 400 when ok:false)
//   POST /eval[?t=<target>]  JavaScript body  -> the value as text
//   POST /nav[?t=<target>]   URL body         -> navigate result as text
//   GET  /tabs               one page per line, "*" marks the active target
//   GET  /ops                one operation per line with its input names
//   GET  /status             daemon pid + get_browser_status
//   POST /stop               dispose and exit
import { openStandaloneCapability, type InvokeResult } from "@agent-software/core";
import { rmSync } from "node:fs";

type Json = Record<string, unknown>;

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;

/** Strings print bare; everything else prints as JSON. */
function asText(value: unknown, maxChars: number): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "undefined");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated ${text.length - maxChars} of ${text.length} chars; narrow the expression or raise BROWSER_CONTROL_MAX_OUTPUT]`;
}

export async function serveDaemon(capabilityDir: string, socketPath: string): Promise<void> {
  const capability = await openStandaloneCapability(capabilityDir);
  const maxChars = Number(process.env["BROWSER_CONTROL_MAX_OUTPUT"]) || 50_000;

  const invokeOnce = async (operation: string, input: Json): Promise<InvokeResult> => {
    try {
      return await capability.runtime.invoke(capability.name, operation, input);
    } catch (error) {
      return failure("EXECUTION_FAILED", (error as Error).message);
    }
  };

  // The last successful connect input, minus any port: ports change when the browser
  // restarts, so a reconnect must rediscover the live one.
  // Before any connect it is the default: preferred browser, with time to click Allow.
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

  const json = (result: InvokeResult) =>
    new Response(`${JSON.stringify(result)}\n`, { status: result.ok ? 200 : 400 });

  /** Text reply: `pick(data)` on success, the error JSON on failure. */
  const text = (result: InvokeResult, pick: (data: any) => unknown) =>
    result.ok ? new Response(`${asText(pick(result.data), maxChars)}\n`) : json(result);

  const stop = async () => {
    await capability.runtime.shutdown().catch(() => {});
    rmSync(socketPath, { force: true });
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  // idleTimeout 0: operations may legitimately run for minutes. (Cast: bun-types leave
  // idleTimeout off the unix-socket overload, but the runtime honors it.)
  Bun.serve({
    unix: socketPath,
    idleTimeout: 0,
    async fetch(request: Request) {
      const url = new URL(request.url);
      const [route, operation] = url.pathname.slice(1).split("/");
      const targetId = url.searchParams.get("t") || undefined;
      const body = (await request.text()).trim();

      switch (route) {
        case "call": {
          let input: unknown = {};
          if (body !== "") {
            try {
              input = JSON.parse(body);
            } catch (error) {
              return json(failure("INPUT_VALIDATION_FAILED", `invalid JSON input: ${(error as Error).message}`));
            }
          }
          if (typeof input !== "object" || input === null || Array.isArray(input)) {
            return json(failure("INPUT_VALIDATION_FAILED", "input must be a JSON object"));
          }
          return json(await invoke(operation ?? "", input as Json));
        }
        case "eval":
          return text(await invoke("evaluate", { expression: body, targetId }), (data) => data.value);
        case "nav":
          return text(await invoke("navigate", { url: body, targetId }), (data) => data);
        case "tabs": {
          const [targets, status] = await Promise.all([
            invoke("list_targets", { types: ["page"] }),
            invoke("get_browser_status"),
          ]);
          const state = status.ok ? (status.data as Json) : {};
          const active = state["activeTargetId"];
          const others = (state["alsoConnected"] as string[] | undefined) ?? [];
          // The header says which browser these tabs are in: a missing tab is often in the other one.
          const header = `# ${state["browser"] ?? "browser"}${others.length > 0 ? ` (also connected: ${others.join(", ")}; switch with: start <name>)` : ""}`;
          return text(targets, (data) =>
            [
              header,
              ...(data.targets as Array<{ targetId: string; url: string; title: string }>).map(
                (t) => `${t.targetId === active ? "*" : " "} ${t.targetId} ${t.url.slice(0, 100)} | ${t.title.slice(0, 60)}`,
              ),
            ].join("\n"),
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
          return json(status.ok ? { ok: true, data: { running: true, pid: process.pid, ...(status.data as Json) } } : status);
        }
        case "stop":
          setTimeout(stop, 10);
          return json({ ok: true, data: { running: false } });
        default:
          return json(failure("OPERATION_NOT_FOUND", `unknown daemon route: /${route}`));
      }
    },
  } as unknown as Parameters<typeof Bun.serve>[0]);
}
