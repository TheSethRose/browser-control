/**
 * Picture-page tracking (Cloudflare Browser Isolation, remote desktops, canvas apps) and image helpers.
 */
import type { InvokeResult } from "@agent-software/core";
import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recognizeText, type Recognizer } from "./ocr";

type Json = Record<string, unknown>;
type Invoker = (operation: string, input?: Json) => Promise<InvokeResult>;
type EvalHelper = (callExpr: string, targetId?: string, timeoutMs?: number) => Promise<InvokeResult>;

const failure = (code: string, message: string): InvokeResult =>
  ({ ok: false, error: { code, message } }) as InvokeResult;
const valueOf = (res: InvokeResult): string => (res.ok ? String((res.data as Json)["value"] ?? "") : "");
const messageOf = (res: InvokeResult): string => (res.ok ? "" : res.error.message);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Pixel width of a PNG or JPEG file, or undefined when it can't be read. */
export async function imageWidth(path: string): Promise<number | undefined> {
  try {
    const v = new DataView(await Bun.file(path).arrayBuffer());
    if (v.getUint32(0) === 0x89504e47) return v.getUint32(16);
    for (let i = 2; i + 9 < v.byteLength; ) {
      const marker = v.getUint16(i);
      if (marker >= 0xffc0 && marker <= 0xffc3) return v.getUint16(i + 7);
      i += 2 + v.getUint16(i + 2);
    }
  } catch {
    // unreadable: the caller keeps the first capture
  }
  return undefined;
}

export function createPictureTracker(
  invoke: Invoker,
  evalHelper: EvalHelper,
  recognize: Recognizer = recognizeText,
) {
  /** Text last recognized on each picture page, to report what an action changed. */
  const seenText = new Map<string, Map<string, string>>();

  const isPicture = async (targetId?: string) => valueOf(await evalHelper("__bc.surface()", targetId)) === "picture";

  async function canvasHash(targetId?: string): Promise<string> {
    const res = await evalHelper("__bc.canvasHash()", targetId, 2_000);
    return res.ok ? valueOf(res) : "";
  }

  /** Wait until the canvas hash changes (remote frame redrawn), falling back to a short pause if tainted. */
  async function waitForRedraw(beforeHash: string, targetId?: string): Promise<void> {
    if (!beforeHash) {
      await sleep(450);
      return;
    }
    const deadline = Date.now() + 800;
    while (Date.now() < deadline) {
      await sleep(75);
      const now = await canvasHash(targetId);
      if (now && now !== beforeHash) {
        await sleep(100);
        return;
      }
    }
  }

  /** Recognize the visible text of a tab from a screenshot: one "x,y "text"" line each, in click coordinates. */
  async function readPicture(
    targetId?: string,
  ): Promise<{ ok: true; lines: Map<string, string> } | { ok: false; res: InvokeResult }> {
    const box = await evalHelper("__bc.viewport()", targetId);
    if (!box.ok) return { ok: false, res: box };
    const v = JSON.parse(valueOf(box)) as { x: number; y: number; width: number; height: number };
    const path = join(tmpdir(), `bc-ocr-${randomUUID()}.png`);
    const shot = await invoke("capture_screenshot", {
      format: "png",
      path,
      clip: { x: v.x, y: v.y, width: v.width, height: v.height, scale: 1 },
      ...(targetId ? { targetId } : {}),
    });
    if (!shot.ok) return { ok: false, res: shot };
    try {
      const boxes = await recognize(String((shot.data as Json)["path"] ?? path));
      boxes.sort((a, b) => (Math.abs(a.y - b.y) < 0.008 ? a.x - b.x : a.y - b.y));
      const lines = new Map<string, string>();
      for (const b of boxes) {
        const at = `${Math.round((b.x + b.width / 2) * v.width)},${Math.round((b.y + b.height / 2) * v.height)}`;
        lines.set(`${b.text}@${Math.round(b.y * 50)}`, `${at} "${b.text.replace(/"/g, "'")}"`);
      }
      return { ok: true, lines };
    } catch (error) {
      return { ok: false, res: failure("EXECUTION_FAILED", (error as Error).message) };
    } finally {
      // The picture holds whatever was on screen; keep only the text that was asked for.
      await unlink(String((shot.data as Json)["path"] ?? path)).catch(() => {});
    }
  }

  function remember(targetId: string | undefined, lines: Map<string, string>): void {
    seenText.set(targetId ?? "", lines);
  }

  /** On a picture page the DOM never changes, so compare recognized text before and after instead. */
  async function pictureChanges(targetId?: string, beforeHash = ""): Promise<string> {
    const before = seenText.get(targetId ?? "");
    if (!before) return "# picture page: run ocr to read the result";
    await waitForRedraw(beforeHash, targetId);
    const now = await readPicture(targetId);
    if (!now.ok) return `# could not read the picture: ${messageOf(now.res).slice(0, 160)}`;
    seenText.set(targetId ?? "", now.lines);
    const out: string[] = [];
    for (const [key, line] of now.lines) if (!before.has(key)) out.push(`+ ${line}`);
    for (const [key, line] of before) if (!now.lines.has(key)) out.push(`- ${line.replace(/^\S+ /, "")}`);
    if (out.length === 0) return "# no visible text change yet (the remote page may still be drawing; run ocr again)";
    return out.length > 40 ? [...out.slice(0, 40), `# … ${out.length - 40} more changes; run ocr`].join("\n") : out.join("\n");
  }

  return { isPicture, canvasHash, readPicture, remember, pictureChanges };
}
