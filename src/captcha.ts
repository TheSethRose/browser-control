/**
 * Agent-native CAPTCHA reporting.
 *
 * The tool never solves a CAPTCHA: it detects one and reports what it found, and stops.
 * The agent reads the report and answers with its own tools (click, type, drag, vision),
 * exactly the way an agent plays a CAPTCHA game itself — the tool stays the detector,
 * the agent stays the solver.
 *
 * Pure module: status + detection in, one bounded text block out. No browser, no network,
 * no I/O. The caller owns detection (`checkChallenge`) and the act of solving.
 */

import type { ChallengeDetection } from "./challenges";
import { sanitizeChallengeText } from "./challenges";

/** What the widget on the page looks like. Best-effort: "unknown" means read the page. */
export type WidgetType = "checkbox" | "image" | "slider" | "audio" | "video" | "unknown";

/** What `solve_captcha` knows about the page right now. */
export interface CaptchaStatus {
  status: "clear" | "interactive" | "block" | "non-interactive-timeout" | "unknown";
  waited: boolean;
  url?: string;
  detection?: ChallengeDetection;
}

/**
 * Best-effort widget-type hint. The reason string is matched first — it carries the vendor's own words —
 * then the vendor map. "unknown" is the honest fallback: read the page.
 */
export function widgetTypeOf(detection: ChallengeDetection): WidgetType {
  if (detection.kind !== "interactive") return "unknown";
  const reason = detection.reason.toLowerCase();
  if (/audio|sound|listen|hear/.test(reason)) return "audio";
  if (/video|watch/.test(reason)) return "video";
  if (/slider|drag|hold|slide/.test(reason)) return "slider";
  if (/image|select|choose|pick|square/.test(reason)) return "image";
  if (/checkbox|robot|human/.test(reason)) return "checkbox";

  // Vendor map: only cloudflare/recaptcha/hcaptcha report a checkbox-type widget,
  // PerimeterX a hold/slide widget, DataDome an image-select widget.
  switch (detection.vendor) {
    case "cloudflare":
    case "recaptcha":
    case "hcaptcha":
      return "checkbox";
    case "perimeterx":
      return "slider";
    case "datadome":
      return "image";
    default:
      return "unknown";
  }
}

/** The exact next action to take, keyed off the widget type. */
const ACTION_BY_WIDGET: Record<WidgetType, string> = {
  checkbox: "click the widget's checkbox — use a fresh snap ref or click --xy at the widget",
  image: "read the image, then choose or type the answer",
  slider: "drag the slider handle into its gap — use a fresh frame ref or click --xy",
  audio: "listen for the audio challenge — hand off if the agent cannot hear it",
  video: "watch or play the video in the widget",
  unknown: "read the widget in the page, then act (click, type, or drag)",
};

function originOf(url: string | undefined): string {
  if (!url) return "this page";
  try {
    const parsed = new URL(url);
    if ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.origin) {
      return sanitizeChallengeText(parsed.origin, 120);
    }
  } catch {
    /* fall through */
  }
  return "this page";
}

function safeReason(reason: string): string {
  return sanitizeChallengeText(reason, 160) || "security check";
}

/**
 * One bounded report block for the agent. Never throws.
 * The first line is the verdict; the next lines say what to do and how to verify.
 */
export function formatCaptchaReport(status: CaptchaStatus, verify = false): string {
  const origin = originOf(status.url);
  const clearLine = `clear — no challenge detected on ${origin}`;

  if (status.status === "clear") {
    return verify ? `CAPTCHA verify: ${clearLine}` : `CAPTCHA: ${clearLine}`;
  }

  if (status.status === "unknown" || !status.detection) {
    return verify
      ? `CAPTCHA verify: unknown — the probe failed to read the page. Is the tab alive? Try snap.`
      : `CAPTCHA: unknown — the probe failed to read the page. Is the tab alive? Try snap.`;
  }

  const { vendor, kind, reason } = status.detection;
  const safe = safeReason(reason);

  if (kind === "block") {
    return `BLOCKED: ${vendor} refused the visit on ${origin} (${safe}). Stop and tell the user; do not retry or reload in a loop.`;
  }

  if (kind === "interactive") {
    const widget = widgetTypeOf(status.detection);
    const lines = [`CAPTCHA${verify ? " verify" : ""}: ${vendor} interactive on ${origin} (${safe})`];
    lines.push(`widget (hint): ${widget} — ${ACTION_BY_WIDGET[widget]}`);
    lines.push(`verify: solve_captcha --verify`);
    if (verify) lines.push(`status: still present — the page did not clear after the answer`);
    return lines.join("\n");
  }

  // non-interactive: report what to do, never claim it is still present without evidence.
  const waited = status.waited ? " (did not auto-clear within the wait budget)" : "";
  const lines = [`CAPTCHA${verify ? " verify" : ""}: ${vendor} non-interactive on ${origin}${waited} (${safe})`];
  lines.push(`next: wait briefly, then re-check with solve_captcha --verify; hand off if stuck`);
  return lines.join("\n");
}
