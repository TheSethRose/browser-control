/**
 * Text recognition for pages that are only a picture (a remote-isolated browser, a canvas app).
 * Uses macOS Vision through a small Swift program compiled once into the user's cache directory
 * and kept warm in `--loop` mode so repeated OCR calls skip Vision model startup.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import source from "./ocr.swift.txt";

/** One piece of recognized text; the box is in fractions of the image from its top-left corner. */
export type TextBox = { x: number; y: number; width: number; height: number; text: string };

const END_MARKER = "__BC_OCR_END__";
const ERR_PREFIX = "__BC_OCR_ERR__ ";
const WORKER_IDLE_MS = 5 * 60_000;

async function run(cmd: string[], timeoutMs: number): Promise<{ code: number; stdout: string; stderr: string }> {
  let proc;
  try {
    proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  } catch {
    return { code: 127, stdout: "", stderr: `${cmd[0]} not found` };
  }
  const timer = setTimeout(() => proc.kill(), timeoutMs);
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  clearTimeout(timer);
  return { code, stdout, stderr: stderr.trim() };
}

let building: Promise<string> | undefined;

/** Path of the compiled recognizer, building it on first use (about five seconds, once per version). */
function recognizer(): Promise<string> {
  building ??= (async () => {
    if (process.platform !== "darwin") {
      throw new Error("OCR_UNAVAILABLE: text recognition needs macOS");
    }
    const dir = join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "browser-control");
    const bin = join(dir, `ocr-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`);
    if (existsSync(bin)) return bin;
    await mkdir(dir, { recursive: true });
    const src = `${bin}.swift`;
    await writeFile(src, source);
    const built = await run(["swiftc", "-O", "-o", `${bin}.tmp`, src], 120_000);
    if (built.code !== 0) {
      throw new Error(
        built.code === 127
          ? "OCR_UNAVAILABLE: text recognition needs the Swift compiler; ask the user to run: xcode-select --install"
          : `OCR_UNAVAILABLE: could not build the recognizer: ${built.stderr.slice(0, 300)}`,
      );
    }
    await rename(`${bin}.tmp`, bin);
    return bin;
  })();
  building.catch(() => {
    building = undefined;
  });
  return building;
}

export function parseBoxes(out: string): TextBox[] {
  const boxes: TextBox[] = [];
  for (const line of out.split("\n")) {
    const m = /^(\S+) (\S+) (\S+) (\S+) (.+)$/.exec(line);
    if (!m) continue;
    const [x, y, width, height] = [m[1], m[2], m[3], m[4]].map(Number) as [number, number, number, number];
    if ([x, y, width, height].every(Number.isFinite)) boxes.push({ x, y, width, height, text: m[5]!.trim() });
  }
  return boxes;
}

type WarmWorker = {
  proc: ReturnType<typeof Bun.spawn>;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  buf: string;
  idleTimer?: ReturnType<typeof setTimeout>;
};

let worker: WarmWorker | undefined;
let queue: Promise<unknown> = Promise.resolve();

/** Stop the warm OCR worker, if one is running. */
export function disposeOcr(): void {
  const current = worker;
  worker = undefined;
  if (!current) return;
  if (current.idleTimer) clearTimeout(current.idleTimer);
  try {
    current.reader.cancel().catch(() => {});
  } catch { /* ignore */ }
  try {
    current.proc.kill();
  } catch { /* ignore */ }
}

function resetIdleTimer(w: WarmWorker): void {
  if (w.idleTimer) clearTimeout(w.idleTimer);
  w.idleTimer = setTimeout(() => {
    if (worker === w) disposeOcr();
  }, WORKER_IDLE_MS);
  w.idleTimer.unref?.();
}

function spawnWorker(bin: string): WarmWorker {
  const proc = Bun.spawn([bin, "--loop"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
  const w: WarmWorker = { proc, reader: proc.stdout.getReader(), buf: "" };
  proc.exited.then(() => {
    if (worker === w) {
      if (w.idleTimer) clearTimeout(w.idleTimer);
      worker = undefined;
    }
  });
  resetIdleTimer(w);
  return w;
}

async function queryWorker(w: WarmWorker, imagePath: string, timeoutMs: number): Promise<TextBox[]> {
  resetIdleTimer(w);
  const decoder = new TextDecoder();
  const stdin = w.proc.stdin as { write(data: string): void; flush(): void };
  stdin.write(`${imagePath}\n`);
  stdin.flush();

  const lines: string[] = [];
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    let nl = w.buf.indexOf("\n");
    while (nl !== -1) {
      const line = w.buf.slice(0, nl).replace(/\r$/, "");
      w.buf = w.buf.slice(nl + 1);
      if (line === END_MARKER) {
        resetIdleTimer(w);
        return parseBoxes(lines.join("\n"));
      }
      if (line.startsWith(ERR_PREFIX)) {
        resetIdleTimer(w);
        throw new Error(`OCR_FAILED: ${line.slice(ERR_PREFIX.length)}`);
      }
      lines.push(line);
      nl = w.buf.indexOf("\n");
    }
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      disposeOcr();
      throw new Error(`OCR_FAILED: timed out after ${timeoutMs}ms`);
    }
    const read = await Promise.race([
      w.reader.read(),
      new Promise<{ done: true; timedOut: true }>((resolve) =>
        setTimeout(() => resolve({ done: true, timedOut: true }), remaining),
      ),
    ]);
    if ("timedOut" in read) {
      disposeOcr();
      throw new Error(`OCR_FAILED: timed out after ${timeoutMs}ms`);
    }
    if (read.done) {
      disposeOcr();
      throw new Error("OCR_FAILED: worker exited unexpectedly");
    }
    w.buf += decoder.decode(read.value, { stream: true });
  }
}

export function recognizeText(imagePath: string): Promise<TextBox[]> {
  const next = queue.then(async () => {
    const bin = await recognizer();
    // The first run after a restart loads the system model and can take half a minute.
    try {
      worker ??= spawnWorker(bin);
      return await queryWorker(worker, imagePath, 90_000);
    } catch (error) {
      // If a stale worker died before answering, retry once with a fresh worker.
      if (!worker && /exited unexpectedly/.test((error as Error).message)) {
        worker = spawnWorker(bin);
        return await queryWorker(worker, imagePath, 90_000);
      }
      throw error;
    }
  });
  queue = next.catch(() => {});
  return next;
}

export type Recognizer = typeof recognizeText;
