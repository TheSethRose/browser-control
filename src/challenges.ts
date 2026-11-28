/**
 * Bot-challenge and block-page detection.
 *
 * Reads what a page shows (title, a text sample, frame and script URLs, marker elements, the HTTP
 * status) and names what is in the way: a vendor challenge that clears by itself, one a person has
 * to answer, or a hard refusal. Detection only: nothing here solves, clicks, or bypasses anything.
 */

import { escapeControls, scrubPromptTokens, wrapUntrusted } from "./safety";

export type ChallengeVendor =
  | "cloudflare"
  | "akamai"
  | "datadome"
  | "perimeterx"
  | "imperva"
  | "aws-waf"
  | "recaptcha"
  | "hcaptcha"
  | "generic";

export type ChallengeKind = "non-interactive" | "interactive" | "block";

export type ChallengeDetection = {
  readonly vendor: ChallengeVendor;
  readonly kind: ChallengeKind;
  /** The evidence that decided it, for logs and the agent ("title: Just a moment...", "frame https://..."). */
  readonly reason: string;
};

/** Page facts the caller collects. The caller bounds every field. */
export type ChallengeProbe = {
  readonly url: string;
  /** `document.title`, trimmed. */
  readonly title: string;
  /** HTTP status of the navigation, when known. */
  readonly status?: number;
  /** The first 3000 characters of `document.body.innerText`. */
  readonly text: string;
  /** Length of the whole `innerText`; tells a short interstitial from a long page. Falls back to `text.length`. */
  readonly textLength?: number;
  /** URLs of the page's frames. */
  readonly frameUrls?: readonly string[];
  /** Up to 50 script `src` values. */
  readonly scriptSrcs?: readonly string[];
  /** Entries of `probeSelectors` that matched at least one element. */
  readonly selectors?: readonly string[];
  /** The matched entries with at least one element of non-zero size. */
  readonly visibleSelectors?: readonly string[];
};

/** Pages whose full text is shorter than this count as interstitial-sized. */
export const SHORT_PAGE_CHARS = 1_500;
const TEXT_SAMPLE_CHARS = 3_000;

type Row = Record<string, string | null>;

/**
 * One marker element. `css` is what the page is queried with. `id`, `idPrefix`, `cls` and `src` say
 * how a `bc.query` row (id, class, src) is matched back to it; a marker with none of them is only
 * found by a dedicated query.
 */
type Marker = {
  readonly css: string;
  /** Cheap enough and specific enough for the first-pass check on every suspicious page. */
  readonly fast?: boolean;
  readonly id?: string;
  readonly idPrefix?: string;
  readonly cls?: string;
  readonly src?: string;
};

const MARKERS: readonly Marker[] = [
  // Cloudflare interstitial, widget, and error page.
  { css: "#challenge-running", fast: true, id: "challenge-running" },
  { css: "#challenge-form", fast: true, id: "challenge-form" },
  { css: "#challenge-stage", fast: true, id: "challenge-stage" },
  { css: "#cf-challenge-running", fast: true, id: "cf-challenge-running" },
  { css: "#cf-please-wait", fast: true, id: "cf-please-wait" },
  { css: "#cf-error-details", fast: true, id: "cf-error-details" },
  { css: ".cf-turnstile", cls: "cf-turnstile" },
  { css: "iframe[src*='challenges.cloudflare.com']", src: "challenges.cloudflare.com" },
  // Akamai Bot Manager.
  { css: "#sec-if-cpt-container", fast: true, id: "sec-if-cpt-container" },
  { css: "#sec-cpt-if", fast: true, id: "sec-cpt-if" },
  // DataDome.
  { css: "#ddv1-captcha-container", fast: true, id: "ddv1-captcha-container" },
  { css: "iframe[src*='captcha-delivery.com']", fast: true, src: "captcha-delivery.com" },
  // PerimeterX / HUMAN.
  { css: "#px-captcha", fast: true, id: "px-captcha" },
  { css: "[id^='px-captcha']", idPrefix: "px-captcha" },
  // Imperva / Incapsula.
  { css: "#main-iframe[src*='_Incapsula_Resource']", fast: true, id: "main-iframe", src: "_Incapsula_Resource" },
  { css: "iframe[src*='_Incapsula_Resource']", src: "_Incapsula_Resource" },
  // AWS WAF CAPTCHA element.
  { css: "awswaf-captcha", fast: true },
  // reCAPTCHA and hCaptcha widgets.
  { css: ".g-recaptcha", cls: "g-recaptcha" },
  { css: "iframe[src*='/recaptcha/']", src: "/recaptcha/" },
  { css: ".h-captcha", cls: "h-captcha" },
  { css: "iframe[src*='hcaptcha.com']", src: "hcaptcha.com" },
];

/** Every marker the full probe checks. `classifyChallenge` reads matches by these exact strings. */
export const probeSelectors: readonly string[] = MARKERS.map((m) => m.css);

/** The interstitial and block markers for the cheap first-pass check (no plain widgets). */
export const fastVendorSelectors: readonly string[] = MARKERS.filter((m) => m.fast).map((m) => m.css);

const CF_INTERSTITIAL_MARKERS = ["#challenge-running", "#challenge-form", "#challenge-stage", "#cf-challenge-running", "#cf-please-wait"];

/** Cloudflare's interstitial title in the languages it ships. */
const CF_TITLE =
  /^(?:just a moment|un instant|einen moment|un momento|um momento|een moment|één moment|chwileczk|bir dakika|подождите|одну минуту|しばらくお待ちください|请稍候|請稍候|잠시만 기다리십시오)/i;
const CF_BLOCK_TITLE = /attention required!?\s*\|\s*cloudflare|used cloudflare to restrict access/i;
const CF_BLOCK_TEXT = /you have been blocked|cloudflare ray id/i;

const DENIAL_TITLE =
  /^(?:(?:error\s*)?(?:403|451)(?:\s*[-:|–]?\s*(?:forbidden|access denied|unavailable for legal reasons))?|access denied|access forbidden|forbidden|access to this page has been denied\.?|request (?:blocked|rejected)|(?:sorry, )?you have been blocked)$/i;
const DENIAL_TEXT =
  /^\s*(?:access denied|forbidden|access to this page has been denied|request (?:blocked|rejected)|sorry, you have been blocked)|you don'?t have permission to access/i;

/** Titles a verification page uses, as the whole title or before a " | site" suffix. */
const CHALLENGE_TITLE =
  /^(?:security check|one more step|pardon our interruption|are you a (?:robot|human)\??|human verification|verify(?:ing)? (?:that )?you are (?:a )?human|bot (?:check|verification)|captcha|security verification|access verification|ddos protection)(?:[\s.!?…]*$|\s+[|–—-]\s)/i;

/** Wording that asks the visitor to prove they are a person. */
const HUMAN_CUE =
  /\b(?:(?:verify|confirm|prove)(?:ing)? (?:that )?you(?: are|'re) (?:a )?human|are you a (?:robot|human)|i'?m not a robot|unusual traffic|(?:solve|complete) the (?:captcha|security check|challenge)|human verification)\b/i;
/** PerimeterX's "Press & Hold" prompt, not a device manual's "press and hold the power button". */
const PX_HOLD = /press\s*(?:&|&amp;|and)\s*hold\b[^.!?]{0,60}?\b(?:human|robot|not a bot)/i;
const AKAMAI_REFERENCE = /reference\s*#\s*\d+\.[0-9a-z]+\.\d+/i;
const IMPERVA_INCIDENT = /incapsula incident id/i;
const CAPTCHA_WORD = /captcha/i;

const SUSPICIOUS_TITLE =
  /just a moment|checking your browser|please wait|attention required|security check|one more step|pardon our interruption|captcha|are you a (?:robot|human)|verify(?:ing)? you are (?:a )?human|human verification|access denied|forbidden|you have been blocked|request blocked|has been denied/i;
const SUSPICIOUS_URL =
  /\/cdn-cgi\/challenge-platform\/|[?&]__cf_chl_|google\.[a-z.]+\/sorry\/|captcha|_incapsula_resource|\/challenge(?:[/?#]|$)|perfdrive\.com|\/blocked(?:[/?#]|$)/i;

/** Flatten page-derived text to one safe line: no controls, no boundary or chat-template tokens. */
export function sanitizeChallengeText(value: string, maxLen = 160): string {
  const flat = scrubPromptTokens(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const cut = flat.length > maxLen ? `${flat.slice(0, Math.max(0, maxLen - 1))}…` : flat;
  return escapeControls(cut);
}

export const isDenialTitle = (title: string): boolean => DENIAL_TITLE.test(title.trim());
export const isSuspiciousTitle = (title: string): boolean => {
  const t = title.trim();
  return CF_TITLE.test(t) || CHALLENGE_TITLE.test(t) || DENIAL_TITLE.test(t) || SUSPICIOUS_TITLE.test(t);
};
export const isSuspiciousUrl = (url: string): boolean => SUSPICIOUS_URL.test(url.trim());

type Page = {
  url: string;
  title: string;
  text: string;
  short: boolean;
  status: number | undefined;
  frames: string[];
  scripts: string[];
  found: Set<string>;
  shown: Set<string>;
};

function readPage(probe: ChallengeProbe): Page {
  const text = probe.text ?? "";
  const length = probe.textLength ?? text.length;
  return {
    url: probe.url ?? "",
    title: (probe.title ?? "").trim(),
    text,
    short: length < SHORT_PAGE_CHARS,
    status: typeof probe.status === "number" && probe.status > 0 ? probe.status : undefined,
    frames: [...(probe.frameUrls ?? [])],
    scripts: [...(probe.scriptSrcs ?? [])],
    found: new Set(probe.selectors ?? []),
    shown: new Set(probe.visibleSelectors ?? []),
  };
}

const ev = {
  title: (p: Page) => `title: ${sanitizeChallengeText(p.title, 80)}`,
  text: (s: string) => `text: ${sanitizeChallengeText(s, 80)}`,
  frame: (u: string) => `frame ${sanitizeChallengeText(u, 120)}`,
  script: (u: string) => `script ${sanitizeChallengeText(u, 120)}`,
  element: (css: string) => `element ${css}`,
  status: (n: number) => `status ${n}`,
  url: (u: string) => `url ${sanitizeChallengeText(u, 120)}`,
};

function hit(vendor: ChallengeVendor, kind: ChallengeKind, evidence: Array<string | undefined | false>): ChallengeDetection {
  const reason = evidence.filter((e): e is string => typeof e === "string" && e !== "").join(", ");
  return { vendor, kind, reason: sanitizeChallengeText(reason, 240) || vendor };
}

const firstMatch = (text: string, re: RegExp): string | undefined => re.exec(text)?.[0];
const anyFound = (p: Page, list: readonly string[]) => list.find((css) => p.found.has(css));
const lower = (s: string) => s.toLowerCase();

// Vendor block pages: the vendor's own refusal wording or reference format.

function cloudflareBlock(p: Page): ChallengeDetection | undefined {
  const blockedText = firstMatch(p.text, CF_BLOCK_TEXT);
  const titled = CF_BLOCK_TITLE.test(p.title);
  const details = p.found.has("#cf-error-details");
  if (!blockedText || !(titled || details || /cloudflare ray id/i.test(p.text))) return undefined;
  return hit("cloudflare", "block", [titled && ev.title(p), details && ev.element("#cf-error-details"), ev.text(blockedText)]);
}

function akamaiBlock(p: Page): ChallengeDetection | undefined {
  const ref = firstMatch(p.text, AKAMAI_REFERENCE);
  if (!ref || !(isDenialTitle(p.title) || /permission to access/i.test(p.text))) return undefined;
  return hit("akamai", "block", [p.status !== undefined && ev.status(p.status), p.title !== "" && ev.title(p), ev.text(ref)]);
}

function impervaBlock(p: Page): ChallengeDetection | undefined {
  const incident = p.short ? firstMatch(p.text, IMPERVA_INCIDENT) : undefined;
  return incident ? hit("imperva", "block", [ev.text(incident)]) : undefined;
}

// Vendor challenges: interstitials that clear by themselves, or prompts a person must answer.

function cloudflareChallenge(p: Page): ChallengeDetection | undefined {
  const titled = p.short && CF_TITLE.test(p.title);
  const marker = anyFound(p, CF_INTERSTITIAL_MARKERS);
  const cfFrames = p.frames.filter((u) => /\/\/challenges\.cloudflare\.com\//i.test(u));
  // A Turnstile frame alone is a form widget, not an interstitial.
  const pageFrame = cfFrames.find((u) => !/\/turnstile\//i.test(u));
  const cfUrl = /\/cdn-cgi\/challenge-platform\/|[?&]__cf_chl_/i.test(p.url);
  if (!titled && !marker && !pageFrame && !cfUrl) return undefined;
  const widget = p.shown.has(".cf-turnstile") ? ".cf-turnstile" : undefined;
  const cue = firstMatch(p.text, HUMAN_CUE);
  const evidence = [titled && ev.title(p), marker && ev.element(marker), pageFrame && ev.frame(pageFrame), cfUrl && ev.url(p.url)];
  if (widget || cue) {
    return hit("cloudflare", "interactive", [...evidence, widget && ev.element(widget), !widget && cue && ev.text(cue)]);
  }
  return hit("cloudflare", "non-interactive", evidence);
}

function akamaiChallenge(p: Page): ChallengeDetection | undefined {
  if (p.shown.has("#sec-cpt-if")) return hit("akamai", "interactive", [ev.element("#sec-cpt-if")]);
  const marker = anyFound(p, ["#sec-if-cpt-container", "#sec-cpt-if"]);
  return marker ? hit("akamai", "non-interactive", [ev.element(marker)]) : undefined;
}

function dataDomeChallenge(p: Page): ChallengeDetection | undefined {
  const frame = p.frames.find((u) => /\/\/[^/]*captcha-delivery\.com\//i.test(u));
  if (frame) {
    const kind: ChallengeKind = /\/interstitial\//i.test(frame) ? "non-interactive" : "interactive";
    return hit("datadome", kind, [ev.frame(frame)]);
  }
  const marker = anyFound(p, ["#ddv1-captcha-container", "iframe[src*='captcha-delivery.com']"]);
  return marker ? hit("datadome", "interactive", [ev.element(marker)]) : undefined;
}

function perimeterXChallenge(p: Page): ChallengeDetection | undefined {
  const marker = anyFound(p, ["#px-captcha", "[id^='px-captcha']"]);
  const hold = p.short ? firstMatch(p.text, PX_HOLD) : undefined;
  if (!marker && !hold) return undefined;
  return hit("perimeterx", "interactive", [marker && ev.element(marker), hold && ev.text(hold)]);
}

function impervaChallenge(p: Page): ChallengeDetection | undefined {
  if (!p.short) return undefined;
  const isResource = (u: string) => lower(u).includes("_incapsula_resource");
  const frame = p.frames.find(isResource);
  const script = frame ? undefined : p.scripts.find(isResource);
  const marker = frame || script ? undefined : anyFound(p, ["#main-iframe[src*='_Incapsula_Resource']", "iframe[src*='_Incapsula_Resource']"]);
  if (!frame && !script && !marker) return undefined;
  const evidence = [frame && ev.frame(frame), script && ev.script(script), marker && ev.element(marker)];
  const captcha = firstMatch(p.text, CAPTCHA_WORD) ?? firstMatch(p.text, HUMAN_CUE);
  const widgetFrame = p.frames.find((u) => /\/recaptcha\/|hcaptcha\.com\//i.test(u));
  if (captcha || widgetFrame) {
    return hit("imperva", "interactive", [...evidence, captcha && ev.text(captcha), widgetFrame && ev.frame(widgetFrame)]);
  }
  return hit("imperva", "non-interactive", evidence);
}

/** A refusal with no vendor wording: a 403/451, or a short page titled or worded as a denial. */
function denial(p: Page): ChallengeDetection | undefined {
  const refused = p.status === 403 || p.status === 451;
  const titled = isDenialTitle(p.title);
  const worded = p.short ? firstMatch(p.text, DENIAL_TEXT) : undefined;
  if (!(refused && (p.short || titled)) && !(p.short && (titled || worded))) return undefined;
  return hit("generic", "block", [refused && ev.status(p.status!), titled && ev.title(p), !titled && worded && ev.text(worded)]);
}

/** The visitor-facing wall cue: a challenge title or prove-you-are-human wording, on a short page. */
function wallCue(p: Page): string | undefined {
  if (!p.short) return undefined;
  if (CHALLENGE_TITLE.test(p.title)) return ev.title(p);
  const cue = firstMatch(p.text, HUMAN_CUE);
  return cue ? ev.text(cue) : undefined;
}

function awsWafChallenge(p: Page): ChallengeDetection | undefined {
  if (!p.short) return undefined;
  const element = [...p.found].find((css) => css.includes("awswaf-captcha"));
  if (element) return hit("aws-waf", "interactive", [ev.element(element)]);
  // The silent challenge answers 202 while its script runs; the same SDK loads on normal pages.
  const sdk = p.scripts.find((u) => /\.awswaf\.com\//i.test(u));
  return sdk && p.status === 202 ? hit("aws-waf", "non-interactive", [ev.status(202), ev.script(sdk)]) : undefined;
}

function widgetWall(
  p: Page,
  vendor: "recaptcha" | "hcaptcha",
  frameRe: RegExp,
  widgetCss: string,
): ChallengeDetection | undefined {
  const frame = p.frames.find((u) => frameRe.test(u));
  const widget = p.found.has(widgetCss) ? widgetCss : undefined;
  if (!frame && !widget) return undefined;
  // A widget inside a sign-in or contact form is not a wall; a wall says so in its title or text.
  const cue = wallCue(p);
  return cue ? hit(vendor, "interactive", [cue, frame ? ev.frame(frame) : ev.element(widget!)]) : undefined;
}

function recaptchaChallenge(p: Page): ChallengeDetection | undefined {
  if (/^https?:\/\/(?:www\.)?google\.[a-z.]+\/sorry\//i.test(p.url)) {
    return hit("recaptcha", "interactive", [ev.url(p.url)]);
  }
  return widgetWall(p, "recaptcha", /\/recaptcha\/(?:api2|enterprise)\/|recaptcha\.net\/recaptcha\//i, ".g-recaptcha");
}

const hcaptchaChallenge = (p: Page) => widgetWall(p, "hcaptcha", /\/\/(?:[^/]+\.)?hcaptcha\.com\//i, ".h-captcha");

function genericChallenge(p: Page): ChallengeDetection | undefined {
  const cue = wallCue(p);
  return cue ? hit("generic", "interactive", [cue]) : undefined;
}

/**
 * Classify a page. Order matters: a vendor's own block page first, then vendor challenges (a
 * Cloudflare interstitial is served with 403, so it must win over a bare status), then a plain
 * refusal, then embedded CAPTCHA walls, then generic verification pages. `undefined` means no
 * challenge was found.
 */
export function classifyChallenge(probe: ChallengeProbe): ChallengeDetection | undefined {
  const p = readPage(probe);
  const checks = [
    cloudflareBlock,
    akamaiBlock,
    impervaBlock,
    cloudflareChallenge,
    akamaiChallenge,
    dataDomeChallenge,
    perimeterXChallenge,
    impervaChallenge,
    denial,
    awsWafChallenge,
    recaptchaChallenge,
    hcaptchaChallenge,
    genericChallenge,
  ];
  for (const check of checks) {
    const found = check(p);
    if (found) return found;
  }
  return undefined;
}

/** `https://host` for a web URL; anything else is kept as given (sanitized). */
function originOf(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return sanitizeChallengeText(parsed.origin, 120);
  } catch {
    /* not a URL */
  }
  return sanitizeChallengeText(url, 120) || "this page";
}

function headline(detection: ChallengeDetection, origin: string): string {
  const { vendor } = detection;
  switch (detection.kind) {
    case "block":
      return `BLOCKED: ${vendor} refused the visit on ${origin}. Do not retry; tell the user the site blocked this browser.`;
    case "interactive":
      return `CHALLENGE: ${vendor} interactive challenge on ${origin}. A person has to complete it; this tool does not solve CAPTCHAs.`;
    default:
      return `CHALLENGE: ${vendor} non-interactive check on ${origin}. It should clear by itself; re-check before acting.`;
  }
}

/** One-paragraph description with the next step for each kind. */
export function describeChallenge(detection: ChallengeDetection, url: string): string {
  const origin = originOf(url);
  const next =
    detection.kind === "interactive" ? ` Next: handoff("Solve the security check on ${origin}"), then continue.` : "";
  const reason = sanitizeChallengeText(detection.reason);
  return `${headline(detection, origin)}${next}${reason ? ` (${reason})` : ""}`;
}

export type FormatChallengeOptions = {
  /** Where the tab lives: `extension` can run `handoff`, `cdp` cannot. Defaults to `"cdp"`. */
  backend?: "extension" | "cdp";
  /**
   * Put the page-derived reason and URL inside `wrapUntrusted` markers. Use it on error paths the
   * daemon returns without its own untrusted-content wrapper.
   */
  untrustedBoundary?: boolean;
};

const REMEDY_EXTENSION = 'remedy: run handoff "Solve the security check, then continue"';
const REMEDY_CDP = "remedy: ask the user to complete the security check in the browser, then continue";

/**
 * The `CHALLENGE:` / `BLOCKED:` block: a verdict line, a fixed `remedy:` line when a person can
 * help, then the page-derived evidence.
 */
export function formatChallengeOutput(
  detection: ChallengeDetection,
  url: string,
  options: FormatChallengeOptions = {},
): string {
  const lines = [headline(detection, originOf(url))];
  if (detection.kind !== "block") lines.push(options.backend === "extension" ? REMEDY_EXTENSION : REMEDY_CDP);
  const evidence = `reason: ${sanitizeChallengeText(detection.reason) || detection.vendor}\nurl: ${sanitizeChallengeText(url, 300)}`;
  lines.push(options.untrustedBoundary === true ? wrapUntrusted(evidence) : evidence);
  return lines.join("\n");
}

/** Whether a `bc.snapshot` output looks like it could be a challenge page, so a probe is worth running. */
export function isSuspiciousSnapshot(snapText: string): boolean {
  if (/^# WALL: /m.test(snapText)) return true;
  const header = /^# (.*) \| (\S+)\s*$/.exec(snapText.split("\n", 1)[0] ?? "");
  if (!header) return false;
  return isSuspiciousTitle(header[1] ?? "") || isSuspiciousUrl(header[2] ?? "");
}

/**
 * A self-contained, read-only page expression that returns JSON: `{skip:true,url}` for a page that
 * is plainly normal (long, no suspicious title or URL, no fast marker), else `{skip:false,probe}`
 * with a full `ChallengeProbe`. It only reads the DOM and the navigation timing entry. `forceFull`
 * never takes the skip.
 */
export function buildChallengeProbeExpression(forceFull = false): string {
  const config = JSON.stringify({
    full: forceFull,
    short: SHORT_PAGE_CHARS,
    sample: TEXT_SAMPLE_CHARS,
    fast: fastVendorSelectors.join(","),
    markers: probeSelectors,
  });
  return `(() => {
  const cfg = ${config};
  const titleRe = [${CF_TITLE}, ${CHALLENGE_TITLE}, ${DENIAL_TITLE}, ${SUSPICIOUS_TITLE}];
  const urlRe = ${SUSPICIOUS_URL};
  const url = String(location.href || "");
  const title = String(document.title || "").trim();
  const all = document.body ? String(document.body.innerText || "") : "";
  if (!cfg.full && all.length >= cfg.short && !titleRe.some((re) => re.test(title)) && !urlRe.test(url)) {
    let marked = false;
    try { marked = Boolean(document.querySelector(cfg.fast)); } catch (_) {}
    if (!marked) return JSON.stringify({ skip: true, url });
  }
  const list = (css) => { try { return Array.from(document.querySelectorAll(css)); } catch (_) { return []; } };
  const srcOf = (el) => String((el.getAttribute && el.getAttribute("src")) || el.src || "");
  const srcs = (css, cap) => list(css).map(srcOf).filter(Boolean).slice(0, cap);
  const shown = (el) => {
    try {
      const r = el.getBoundingClientRect();
      if (!r || r.width <= 0 || r.height <= 0) return false;
      const st = typeof getComputedStyle === "function" ? getComputedStyle(el) : null;
      return !st || (st.display !== "none" && st.visibility !== "hidden");
    } catch (_) { return false; }
  };
  const selectors = [];
  const visibleSelectors = [];
  for (const css of cfg.markers) {
    const els = list(css);
    if (els.length === 0) continue;
    selectors.push(css);
    if (els.slice(0, 5).some(shown)) visibleSelectors.push(css);
  }
  let responseStatus = 0;
  try {
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav && typeof nav.responseStatus === "number") responseStatus = nav.responseStatus;
  } catch (_) {}
  const probe = {
    url,
    title,
    text: all.slice(0, cfg.sample),
    textLength: all.length,
    frameUrls: srcs("iframe[src]", 20),
    scriptSrcs: srcs("script[src]", 50),
    selectors,
    visibleSelectors,
  };
  if (responseStatus > 0) probe.status = responseStatus;
  return JSON.stringify({ skip: false, probe });
})()`;
}

/**
 * Split a `bc.text` readback (`# title | url`, a blank line, the body, and an optional
 * `# [truncated N of M chars ...]` trailer) into the text sample and the full length.
 */
export function parseBcTextForProbe(raw: string): { text: string; textLength: number } {
  const lines = String(raw ?? "").split("\n");
  if (lines[0]?.startsWith("# ")) lines.splice(0, lines[1] === "" ? 2 : 1);
  let total = 0;
  const trailer = /^# \[truncated \d+ of (\d+) chars/.exec(lines[lines.length - 1] ?? "");
  if (trailer) {
    total = Number(trailer[1]);
    lines.pop();
  }
  const text = lines.join("\n").slice(0, TEXT_SAMPLE_CHARS);
  return { text, textLength: Math.max(total, text.length) };
}

/** Parse a `bc.query` readback (`# N row(s) for ...`, then one JSON object per line). */
export function parseBcQueryRows(raw: string): Array<Record<string, string | null>> {
  const rows: Row[] = [];
  for (const line of String(raw ?? "").split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      const row: Row = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        row[key] = value === null || value === undefined ? null : String(value);
      }
      rows.push(row);
    } catch {
      /* skip a malformed line */
    }
  }
  return rows;
}

function rowMatches(marker: Marker, row: Row): boolean {
  if (marker.id === undefined && marker.idPrefix === undefined && marker.cls === undefined && marker.src === undefined) {
    return false;
  }
  const id = row["id"] ?? "";
  if (marker.id !== undefined && id !== marker.id) return false;
  if (marker.idPrefix !== undefined && !id.startsWith(marker.idPrefix)) return false;
  if (marker.cls !== undefined && !(row["cls"] ?? "").split(/\s+/).includes(marker.cls)) return false;
  if (marker.src !== undefined && !(row["src"] ?? "").includes(marker.src)) return false;
  return true;
}

/**
 * Map `bc.query` rows from the `probeSelectors` query back to the markers they match, in
 * `probeSelectors` order. `hasAwsWafCaptcha` comes from a separate `awswaf-captcha` query, since a
 * row cannot show its tag name.
 */
export function matchProbeSelectorsFromRows(
  rows: ReadonlyArray<Record<string, string | null>>,
  hasAwsWafCaptcha = false,
): string[] {
  const out: string[] = [];
  for (const marker of MARKERS) {
    if (marker.css === "awswaf-captcha" ? hasAwsWafCaptcha : rows.some((row) => rowMatches(marker, row))) {
      out.push(marker.css);
    }
  }
  return out;
}
