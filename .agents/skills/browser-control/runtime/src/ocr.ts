/**
 * Text recognition for pages that are only a picture (a remote-isolated browser, a canvas app).
 * Uses macOS Vision through a small Swift program compiled once into the user's cache directory.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import source from "./ocr.swift.txt";

/** One piece of recognized text; the box is in fractions of the image from its top-left corner. */
export type TextBox = { x: number; y: number; width: number; height: number; text: string };

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

export async function recognizeText(imagePath: string): Promise<TextBox[]> {
  const bin = await recognizer();
  // The first run after a restart loads the system model and can take half a minute.
  const res = await run([bin, imagePath], 90_000);
  if (res.code !== 0) throw new Error(`OCR_FAILED: ${res.stderr.slice(0, 300) || `exit ${res.code}`}`);
  return parseBoxes(res.stdout);
}

export type Recognizer = typeof recognizeText;
