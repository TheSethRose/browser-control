/**
 * Daemon-side screenshot badge annotation (zero DOM mutation on macOS).
 * Compiles a tiny CoreGraphics Swift helper once into ~/.cache/browser-control/.
 */
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import source from "./marks.swift.txt";

export type MarkBox = { id: string; x: number; y: number };

let building: Promise<string | undefined> | undefined;

function compiler(): Promise<string | undefined> {
  building ??= (async () => {
    if (process.platform !== "darwin") return undefined;
    const dir = join(process.env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "browser-control");
    const bin = join(dir, `marks-${createHash("sha256").update(source).digest("hex").slice(0, 12)}`);
    if (existsSync(bin)) return bin;
    await mkdir(dir, { recursive: true });
    const src = `${bin}.swift`;
    await writeFile(src, source);
    let proc;
    try {
      proc = Bun.spawn(["swiftc", "-O", "-o", `${bin}.tmp`, src], { stdout: "ignore", stderr: "ignore", stdin: "ignore" });
    } catch {
      return undefined;
    }
    if ((await proc.exited) !== 0) return undefined;
    await rename(`${bin}.tmp`, bin).catch(() => {});
    return existsSync(bin) ? bin : undefined;
  })();
  return building;
}

/** Draw numbered badges onto a saved PNG/JPEG image. Returns true if drawn natively, false to fall back. */
export async function drawMarksOnImage(imagePath: string, boxes: MarkBox[]): Promise<boolean> {
  if (boxes.length === 0) return true;
  const bin = await compiler();
  if (!bin) return false;
  try {
    const proc = Bun.spawn([bin, imagePath, JSON.stringify(boxes)], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}
