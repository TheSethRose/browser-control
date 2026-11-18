import { describe, expect, test } from "bun:test";
import { EventBuffer, matchesSubset } from "../src/events";
import {
  CdpConnection,
  browserNameFromCommand,
  getBrowserCandidates,
  matchBrowser,
  parseLsofListeners,
  isBrowserLevelMethod,
  parseDevToolsActivePort,
  resolveWsUrl,
  type WebSocketLike,
} from "../src/session";

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: Array<Record<string, any>> = [];
  auto: Record<string, unknown> = { "Browser.getVersion": { product: "Test/1.0" } };
  private listeners = new Map<string, Array<(event: any) => void>>();

  constructor(public url: string) {}

  send(data: string): void {
    const message = JSON.parse(data) as Record<string, any>;
    this.sent.push(message);
    if (Object.prototype.hasOwnProperty.call(this.auto, message.method)) {
      const result = this.auto[message.method];
      queueMicrotask(() => this.receive({ id: message.id, result }));
    }
  }

  close(): void {
    this.readyState = 3;
    this.emit("close", {});
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  emit(type: string, event: any): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  open(): void {
    this.readyState = 1;
    this.emit("open", {});
  }

  receive(message: unknown): void {
    this.emit("message", { data: JSON.stringify(message) });
  }

  respond(method: string, result: unknown): void {
    const message = [...this.sent].reverse().find((m) => m.method === method);
    if (!message) throw new Error(`nothing sent for ${method}`);
    this.receive({ id: message.id, result });
  }
}

function makeConnection(bufferSize = 4) {
  const sockets: FakeSocket[] = [];
  const connection = new CdpConnection({
    defaultTimeoutMs: 1000,
    eventBufferSize: bufferSize,
    createWebSocket: (url) => {
      const socket = new FakeSocket(url);
      sockets.push(socket);
      queueMicrotask(() => socket.open());
      return socket;
    },
  });
  return { connection, sockets };
}

async function respond(socket: FakeSocket, method: string, result: unknown): Promise<void> {
  for (let i = 0; i < 200 && !socket.sent.some((m) => m.method === method); i++) {
    await Bun.sleep(1);
  }
  socket.respond(method, result);
}

async function connectFake(bufferSize = 4) {
  const { connection, sockets } = makeConnection(bufferSize);
  const info = await connection.connect({ wsUrl: "ws://fake" });
  return { connection, socket: sockets[0]!, info };
}

describe("pure helpers", () => {
  test("browser-level method routing", () => {
    expect(isBrowserLevelMethod("Browser.getVersion")).toBe(true);
    expect(isBrowserLevelMethod("Target.getTargets")).toBe(true);
    expect(isBrowserLevelMethod("Extensions.getExtensions")).toBe(true);
    expect(isBrowserLevelMethod("Page.navigate")).toBe(false);
    expect(isBrowserLevelMethod("Runtime.evaluate")).toBe(false);
  });

  test("parseDevToolsActivePort accepts two-line files and rejects malformed ones", () => {
    expect(parseDevToolsActivePort("9222\n/devtools/browser/abc")).toEqual({
      port: 9222,
      path: "/devtools/browser/abc",
    });
    expect(parseDevToolsActivePort("nope\n/devtools/browser/abc")).toBeUndefined();
    expect(parseDevToolsActivePort("9222\nnope")).toBeUndefined();
    expect(parseDevToolsActivePort("9222")).toBeUndefined();
  });

  test("browser candidates are OS-specific", () => {
    const mac = getBrowserCandidates("darwin", "/Users/x", {});
    expect(mac.some((c) => c.name === "Google Chrome" && c.profileDir.includes("Google/Chrome"))).toBe(true);
    const win = getBrowserCandidates("win32", "C:\\Users\\x", { LOCALAPPDATA: "C:\\Users\\x\\AppData\\Local" });
    expect(win.some((c) => c.name === "Microsoft Edge")).toBe(true);
    const linux = getBrowserCandidates("linux", "/home/x", {});
    expect(linux.some((c) => c.profileDir.startsWith("/home/x/.config"))).toBe(true);
  });

  test("matchesSubset compares shallowly", () => {
    expect(matchesSubset({ a: 1, b: { c: 2 } }, { a: 1 })).toBe(true);
    expect(matchesSubset({ a: 1 }, { a: 2 })).toBe(false);
    expect(matchesSubset({ a: 1, b: { c: 2 } }, { b: { c: 2 } })).toBe(true);
    expect(matchesSubset(undefined, { a: 1 })).toBe(false);
  });
});

describe("live port discovery", () => {
  test("parseLsofListeners keeps loopback listeners with their pid", () => {
    const text = "p1744\nf106\nn127.0.0.1:9222\np1818\nf140\nn[::1]:51106\np9\nf3\nn*:7000\n";
    expect(parseLsofListeners(text)).toEqual([
      { pid: 1744, port: 9222 },
      { pid: 1818, port: 51106 },
    ]);
  });

  test("browserNameFromCommand names browsers and skips helpers and other apps", () => {
    const beta = "/Applications/Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta";
    expect(browserNameFromCommand(beta)).toBe("Google Chrome Beta");
    expect(browserNameFromCommand(`${beta} --remote-debugging-port=9222`)).toBe("Google Chrome Beta");
    expect(browserNameFromCommand("/usr/bin/chromium --flag")).toBe("chromium");
    expect(browserNameFromCommand(`${beta} --type=renderer`)).toBeUndefined();
    expect(browserNameFromCommand("/Applications/Slack.app/Contents/MacOS/Slack")).toBeUndefined();
  });

  test("matchBrowser prefers an exact name over a substring", () => {
    const list = [{ name: "Google Chrome" }, { name: "Google Chrome Beta" }, { name: "Brave" }];
    expect(matchBrowser("chrome", list)).toEqual([{ name: "Google Chrome" }]);
    expect(matchBrowser("Beta", list)).toEqual([{ name: "Google Chrome Beta" }]);
    expect(matchBrowser("chrome beta", list)).toEqual([{ name: "Google Chrome Beta" }]);
    expect(matchBrowser("google", list)).toHaveLength(2);
    expect(matchBrowser("firefox", list)).toEqual([]);
  });
});

describe("resolveWsUrl explicit port", () => {
  test("uses webSocketDebuggerUrl when /json/version is available", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ webSocketDebuggerUrl: "ws://127.0.0.1:1234/devtools/browser/abc" }),
    });
    try {
      expect(await resolveWsUrl({ port: server.port })).toBe("ws://127.0.0.1:1234/devtools/browser/abc");
    } finally {
      await server.stop(true);
    }
  });

  test("falls back to the raw /devtools/browser socket when discovery is absent", async () => {
    // Chrome's user-enabled remote-debugging server (chrome://inspect#remote-debugging)
    // answers no /json/version; the port alone must still resolve to a working endpoint.
    const server = Bun.serve({ port: 0, fetch: () => new Response("not found", { status: 404 }) });
    try {
      expect(await resolveWsUrl({ port: server.port })).toBe(
        `ws://127.0.0.1:${server.port}/devtools/browser`,
      );
    } finally {
      await server.stop(true);
    }
  });

  test("a closed port surfaces an INPUT_INVALID error", async () => {
    // Port 1 is effectively always closed in the test environment.
    await expect(resolveWsUrl({ port: 1 })).rejects.toThrow("INPUT_INVALID");
  });
});

describe("CdpConnection routing", () => {
  test("connects, records the browser version, and is idempotent", async () => {
    const { connection, info } = await connectFake();
    expect(info.connected).toBe(true);
    expect(info.browserVersion).toBe("Test/1.0");
    expect((await connection.connect({})).connected).toBe(true);
    connection.close();
    expect(connection.isConnected()).toBe(false);
  });

  test("browser-level methods carry no sessionId; target methods use the active route", async () => {
    const { connection, socket } = await connectFake();
    socket.auto["Target.attachToTarget"] = { sessionId: "s1" };
    await connection.use("t1");

    const targets = connection.call("Target.getTargets", {});
    await respond(socket, "Target.getTargets", { targetInfos: [] });
    await targets;
    expect(socket.sent.find((m) => m.method === "Target.getTargets")?.sessionId).toBeUndefined();

    const navigate = connection.call("Page.navigate", { url: "about:blank" });
    await respond(socket, "Page.navigate", { frameId: "f1" });
    await navigate;
    expect(socket.sent.find((m) => m.method === "Page.navigate")?.sessionId).toBe("s1");
    connection.close();
  });

  test("explicit sessionId and targetId override the active route", async () => {
    const { connection, socket } = await connectFake();
    const bySession = connection.call("Runtime.evaluate", { expression: "1" }, { sessionId: "explicit" });
    await respond(socket, "Runtime.evaluate", { result: { value: 1 } });
    await bySession;
    expect(socket.sent.find((m) => m.method === "Runtime.evaluate")?.sessionId).toBe("explicit");

    socket.auto["Target.attachToTarget"] = { sessionId: "s2" };
    const byTarget = connection.call("DOM.getDocument", {}, { targetId: "t2" });
    await respond(socket, "DOM.getDocument", { root: { nodeId: 1 } });
    const result = await byTarget;
    expect(result).toEqual({ root: { nodeId: 1 } });
    connection.close();
  });

  test("target-scoped calls without a route fail with NO_ACTIVE_TARGET", async () => {
    const { connection } = await connectFake();
    await expect(connection.call("Page.navigate", {})).rejects.toThrow("NO_ACTIVE_TARGET");
    connection.close();
  });

  test("a session Chrome dropped is re-attached once and the call retried", async () => {
    const { connection, socket } = await connectFake();
    socket.auto["Target.attachToTarget"] = { sessionId: "old" };
    await connection.use("t1");
    socket.auto["Target.attachToTarget"] = { sessionId: "new" };

    const call = connection.call("Runtime.evaluate", { expression: "1" });
    for (let i = 0; i < 200 && !socket.sent.some((m) => m.method === "Runtime.evaluate"); i++) await Bun.sleep(1);
    const first = socket.sent.find((m) => m.method === "Runtime.evaluate")!;
    expect(first.sessionId).toBe("old");
    socket.receive({ id: first.id, error: { code: -32001, message: "Session with given id not found." } });
    for (let i = 0; i < 200 && socket.sent.filter((m) => m.method === "Runtime.evaluate").length < 2; i++) await Bun.sleep(1);
    const second = socket.sent.filter((m) => m.method === "Runtime.evaluate")[1]!;
    expect(second.sessionId).toBe("new");
    socket.receive({ id: second.id, result: { ok: true } });
    expect(await call).toEqual({ ok: true });
    expect(connection.getStatus().activeSessionId).toBe("new");
    connection.close();
  });

  test("a call with no reply fails with CDP_TIMEOUT by default", async () => {
    const sockets: FakeSocket[] = [];
    const connection = new CdpConnection({
      callTimeoutMs: 20,
      createWebSocket: (url) => {
        const socket = new FakeSocket(url);
        sockets.push(socket);
        queueMicrotask(() => socket.open());
        return socket;
      },
    });
    await connection.connect({ wsUrl: "ws://fake" });
    await expect(connection.call("Target.getTargets", {})).rejects.toThrow("CDP_TIMEOUT");
    connection.close();
  });

  test("an unexpected socket close clears the route and rejects waiters", async () => {
    const { connection, socket } = await connectFake();
    socket.auto["Target.attachToTarget"] = { sessionId: "s1" };
    await connection.use("t1");
    const waiting = connection.waitForEvent({ method: "Page.loadEventFired" }, 5000, false);
    socket.close();
    await expect(waiting).rejects.toThrow("NOT_CONNECTED");
    expect(connection.getStatus().activeTargetId).toBeUndefined();
  });

  test("pending calls reject when the socket closes", async () => {
    const { connection, socket } = await connectFake();
    const pending = connection.call("Target.getTargets", {});
    await Bun.sleep(5);
    socket.close();
    await expect(pending).rejects.toThrow("NOT_CONNECTED");
    connection.close();
  });
});

describe("CdpConnection events", () => {
  test("wait_for_event resolves from a future event", async () => {
    const { connection, socket } = await connectFake();
    const waiting = connection.waitForEvent({ method: "Page.loadEventFired" }, 1000, true);
    socket.receive({ method: "Page.loadEventFired", params: { timestamp: 1 }, sessionId: "s1" });
    const outcome = await waiting;
    expect(outcome.found).toBe(true);
    if (outcome.found) {
      expect(outcome.event.method).toBe("Page.loadEventFired");
      expect(outcome.event.sessionId).toBe("s1");
    }
    connection.close();
  });

  test("wait_for_event times out as a normal result", async () => {
    const { connection } = await connectFake();
    const outcome = await connection.waitForEvent({ method: "Never.fired" }, 10, true);
    expect(outcome).toEqual({ found: false, timedOut: true, waitedMs: 10 });
    connection.close();
  });

  test("consumeBuffer serves an already-buffered event", async () => {
    const { connection, socket } = await connectFake();
    socket.receive({ method: "Page.frameNavigated", params: { frame: { url: "https://x" } } });
    const outcome = await connection.waitForEvent({ method: "Page.frameNavigated" }, 1000, true);
    expect(outcome.found).toBe(true);
    expect(connection.readEvents({ method: "Page.frameNavigated" }, 100, true).events).toHaveLength(0);
    connection.close();
  });

  test("bounds the buffer and reports dropped events", async () => {
    const { connection, socket } = await connectFake(4);
    for (let i = 0; i < 6; i++) {
      socket.receive({ method: "Network.requestWillBeSent", params: { i } });
    }
    const read = connection.readEvents({}, 100, true);
    expect(read.events).toHaveLength(4);
    expect(read.dropped).toBe(2);
    expect(read.events[0]!.params).toEqual({ i: 2 });
    connection.close();
  });

  test("read_events filters by method and clears only what it returns", async () => {
    const { connection, socket } = await connectFake(10);
    socket.receive({ method: "A.one", params: {} });
    socket.receive({ method: "B.two", params: {} });
    const first = connection.readEvents({ method: "A.one" }, 100, true);
    expect(first.events.map((e) => e.method)).toEqual(["A.one"]);
    const second = connection.readEvents({}, 100, false);
    expect(second.events.map((e) => e.method)).toEqual(["B.two"]);
    connection.close();
  });
});

describe("EventBuffer", () => {
  test("take removes and peek does not", () => {
    const buffer = new EventBuffer(10);
    buffer.push("X.y", { a: 1 });
    expect(buffer.take({ method: "X.y" }, false)?.method).toBe("X.y");
    expect(buffer.size).toBe(1);
    expect(buffer.take({ method: "X.y" }, true)?.method).toBe("X.y");
    expect(buffer.size).toBe(0);
  });
});
