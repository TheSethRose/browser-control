// Adapted from anomalyco/browse (MIT), cli/src/execute/challenge-detection.ts @ ce5578e. Copyright (c) 2025 opencode. See LICENSE.
/**
 * Bot-challenge and block-page classification.
 *
 * After a navigation settles, a caller reads a few cheap signals from the page and classifies it:
 *
 * - `non-interactive`: an interstitial the browser clears by itself (Cloudflare's "Just a moment...", Akamai's and
 *   AWS WAF's silent challenges, a DataDome device check, an Imperva resource wait). The caller may auto-wait on it.
 * - `interactive`: a challenge only a person should answer (Turnstile or reCAPTCHA/hCaptcha checkboxes, PerimeterX
 *   "Press & Hold", a DataDome or AWS WAF captcha). The caller recommends `handoff`; it never solves it.
 * - `block`: the site refused the visit outright (Cloudflare "Sorry, you have been blocked", Akamai or Imperva
 *   "Access Denied"). Retrying makes it worse: stop or ask the user.
 *
 * The signals are vendor markers (challenge frames and scripts, element ids the vendors' pages use) and title/text
 * phrases. Generic phrases ("access denied", "verify you are human") only count on short pages, so an article that
 * mentions them is not a challenge. Detection is deliberately conservative: a miss costs a turn, a false positive
 * costs a wait or a needless handoff.
 *
 * Pure module: input to output, no browser, no network, no I/O. The page-side collection that fills a
 * `ChallengeProbe` lives in the caller.
 */

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
  /** The marker that matched, for logs and the agent ("title: Just a moment...", "iframe challenges.cloudflare.com"). */
  readonly reason: string;
};

/** What the caller reads from the page. Every field is bounded by the reader. */
export type ChallengeProbe = {
  readonly url: string;
  /** `document.title`, already trimmed by the reader. */
  readonly title: string;
  /** The navigation's HTTP status when known. */
  readonly status?: number;
  /** `document.body.innerText`, first 3000 characters. */
  readonly text: string;
  /** Full `innerText` length, to tell short interstitials from long pages. Defaults to `text.length`. */
  readonly textLength?: number;
  /** Frame URLs from the page's frame tree. */
  readonly frameUrls?: readonly string[];
  /** Script `src` values, first 50. */
  readonly scriptSrcs?: readonly string[];
  /** Which of `probeSelectors` matched an element. */
  readonly selectors?: readonly string[];
  /** Which of the matched selectors are visible (non-zero size). */
  readonly visibleSelectors?: readonly string[];
};

/** Element markers the probe checks. Keep in sync with `classifyChallenge`. */
export const probeSelectors = [
  // Cloudflare
  "#challenge-form",
  "#challenge-running",
  "#challenge-stage",
  "#cf-challenge-running",
  ".cf-turnstile",
  "#cf-error-details",
  // Akamai Bot Manager
  "#sec-if-cpt-container",
  "#sec-cpt-if",
  "#sec-text-if",
  // DataDome
  "#ddv1-captcha-container",
  // PerimeterX / HUMAN
  "#px-captcha",
  "#px-captcha-wrapper",
  "[id^='px-captcha']",
  // Imperva / Incapsula
  "#main-iframe[src*='_Incapsula_Resource']",
  // AWS WAF
  "#captcha-container awswaf-captcha",
  "awswaf-captcha",
  "#challenge-container",
  // reCAPTCHA / hCaptcha
  ".g-recaptcha",
  "iframe[src*='/recaptcha/'][title*='challenge']",
  ".h-captcha",
] as const;

/** A short page is an interstitial or a wall, not an article. */
const SHORT_PAGE_CHARS = 1_500;

const textLengthOf = (probe: ChallengeProbe): number => probe.textLength ?? probe.text.length;

const shortPage = (probe: ChallengeProbe): boolean => textLengthOf(probe) < SHORT_PAGE_CHARS;

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

function hasFrame(probe: ChallengeProbe, pattern: RegExp): string | undefined {
  return (probe.frameUrls ?? []).find((url) => pattern.test(url));
}

function hasScript(probe: ChallengeProbe, pattern: RegExp): string | undefined {
  return (probe.scriptSrcs ?? []).find((src) => pattern.test(src));
}

const has = (probe: ChallengeProbe, selector: string): boolean => (probe.selectors ?? []).includes(selector);
const visible = (probe: ChallengeProbe, selector: string): boolean =>
  (probe.visibleSelectors ?? []).includes(selector);

/** Classify a probed page, or `undefined` when it does not look like a challenge or block page. */
export function classifyChallenge(probe: ChallengeProbe): ChallengeDetection | undefined {
  const title = probe.title.trim().toLowerCase();
  const text = probe.text.toLowerCase();
  const host = hostOf(probe.url);
  const reason = (value: string) => value.slice(0, 160);

  // Cloudflare
  if (/sorry, you have been blocked/.test(text) && (has(probe, "#cf-error-details") || /cloudflare/.test(text))) {
    return { vendor: "cloudflare", kind: "block", reason: "text: Sorry, you have been blocked" };
  }
  const cloudflareInterstitial =
    /^just a moment\b|^attention required! \| cloudflare|^checking your browser|^un instant|^einen moment/.test(title) ||
    has(probe, "#challenge-form") ||
    has(probe, "#challenge-running") ||
    has(probe, "#cf-challenge-running") ||
    has(probe, "#challenge-stage");
  // The managed-challenge orchestrator frame marks an interstitial; a Turnstile widget frame alone is
  // often a site's own form widget, so it never flags a page by itself.
  const orchestrator = hasFrame(probe, /^https:\/\/challenges\.cloudflare\.com\/cdn-cgi\/challenge-platform\/.*\/orchestrate\//);
  if (cloudflareInterstitial || (orchestrator !== undefined && shortPage(probe))) {
    // The managed challenge shows Turnstile's checkbox only when it wants a click; until then it clears itself.
    const widget =
      visible(probe, ".cf-turnstile") ||
      /verify you are human by completing|click to verify|confirm you are human/.test(text);
    return {
      vendor: "cloudflare",
      kind: widget ? "interactive" : "non-interactive",
      reason: reason(
        cloudflareInterstitial ? (probe.title.trim() ? `title: ${probe.title.trim()}` : "element #challenge-*") : `iframe ${orchestrator}`,
      ),
    };
  }

  // PerimeterX / HUMAN
  if (
    has(probe, "#px-captcha") ||
    has(probe, "#px-captcha-wrapper") ||
    has(probe, "[id^='px-captcha']") ||
    (/press (?:&|and) hold/.test(text) && shortPage(probe) && /human|robot|verify|confirm/.test(text))
  ) {
    return {
      vendor: "perimeterx",
      kind: "interactive",
      reason: has(probe, "#px-captcha") ? "element #px-captcha" : "text: Press & Hold",
    };
  }

  // DataDome
  const dataDomeFrame = hasFrame(probe, /captcha-delivery\.com/);
  if (dataDomeFrame !== undefined || has(probe, "#ddv1-captcha-container")) {
    const interstitial = dataDomeFrame !== undefined && /\/interstitial\//.test(dataDomeFrame);
    return {
      vendor: "datadome",
      kind: interstitial ? "non-interactive" : "interactive",
      reason: reason(dataDomeFrame ? `iframe ${dataDomeFrame}` : "element #ddv1-captcha-container"),
    };
  }

  // Akamai Bot Manager
  if (has(probe, "#sec-if-cpt-container") || has(probe, "#sec-cpt-if") || has(probe, "#sec-text-if")) {
    const interactive = visible(probe, "#sec-cpt-if") && /verify|press|slide|captcha/.test(text);
    return {
      vendor: "akamai",
      kind: interactive ? "interactive" : "non-interactive",
      reason: "element #sec-if-cpt-container",
    };
  }
  if (title === "access denied" && /you don't have permission to access/.test(text) && /reference #?\d/.test(text)) {
    return { vendor: "akamai", kind: "block", reason: "title: Access Denied (Akamai reference)" };
  }

  // Imperva / Incapsula
  const incapsula = hasFrame(probe, /_Incapsula_Resource/) ?? hasScript(probe, /_Incapsula_Resource/);
  if (incapsula !== undefined || has(probe, "#main-iframe[src*='_Incapsula_Resource']")) {
    const captcha = /captcha|verify you are human|i am human/.test(text) || hasFrame(probe, /hcaptcha|recaptcha/) !== undefined;
    if (/request unsuccessful|incapsula incident id/.test(text) && !captcha) {
      return { vendor: "imperva", kind: "block", reason: "text: Request unsuccessful (Incapsula)" };
    }
    return {
      vendor: "imperva",
      kind: captcha ? "interactive" : "non-interactive",
      reason: reason(`resource ${incapsula ?? "_Incapsula_Resource"}`),
    };
  }
  if (/incapsula incident id/.test(text) && shortPage(probe)) {
    return { vendor: "imperva", kind: "block", reason: "text: Incapsula incident ID" };
  }

  // AWS WAF
  const awsCaptcha = has(probe, "awswaf-captcha") || has(probe, "#captcha-container awswaf-captcha");
  const awsScript = hasScript(probe, /\.awswaf\.com\//);
  if (awsCaptcha) return { vendor: "aws-waf", kind: "interactive", reason: "element awswaf-captcha" };
  const refused = probe.status === 403 || probe.status === 451;
  if (awsScript !== undefined && !refused && shortPage(probe) && (has(probe, "#challenge-container") || probe.status === 202)) {
    return { vendor: "aws-waf", kind: "non-interactive", reason: reason(`script ${awsScript}`) };
  }

  // Captcha walls: a page that is mostly a reCAPTCHA or hCaptcha widget.
  if (shortPage(probe)) {
    const recaptcha = hasFrame(
      probe,
      /^https:\/\/www\.(?:google|recaptcha)\.(?:com|net)\/recaptcha\/(?:api2|enterprise)\/anchor/,
    );
    const hcaptcha = hasFrame(probe, /^https:\/\/(?:newassets\.|assets\.)?hcaptcha\.com\/captcha\//);
    const wallText =
      /verify you are (?:a )?human|are you a robot|not a robot|unusual traffic|security check|complete the captcha/.test(
        text,
      ) || /captcha|security check|verify/.test(title);
    if (hcaptcha !== undefined && wallText) {
      return { vendor: "hcaptcha", kind: "interactive", reason: reason(`iframe ${hcaptcha}`) };
    }
    if (recaptcha !== undefined && wallText) {
      return { vendor: "recaptcha", kind: "interactive", reason: reason(`iframe ${recaptcha}`) };
    }
    // Google's own "unusual traffic" interstitial.
    if (/^www\.google\./.test(host) && /\/sorry\//.test(probe.url)) {
      return { vendor: "recaptcha", kind: "interactive", reason: "url: google.com/sorry" };
    }
  }

  const denialTitle = /^(?:access denied|403 forbidden|forbidden|blocked|request blocked|you have been blocked)$/.test(title);
  if (refused && denialTitle) {
    return { vendor: "generic", kind: "block", reason: reason(`status ${probe.status}, title: ${probe.title.trim()}`) };
  }

  // Generic block and verification pages, short pages only.
  if (shortPage(probe)) {
    if (
      denialTitle ||
      /^(?:access to this page has been denied|access denied)\b/.test(text.trim())
    ) {
      return {
        vendor: "generic",
        kind: "block",
        reason: reason(`title: ${probe.title.trim() || text.trim().slice(0, 60)}`),
      };
    }
    if (
      /verify (?:that )?you are (?:a )?human|confirm you are (?:a )?human|are you a robot\?|pardon our interruption|please verify you are a human|bot (?:check|detection)/.test(
        `${title}\n${text}`,
      )
    ) {
      const phrase = /verify[^.\n]*human|confirm[^.\n]*human|are you a robot|pardon our interruption|bot (?:check|detection)/.exec(
        `${title}\n${text}`,
      )?.[0];
      return { vendor: "generic", kind: "interactive", reason: reason(`text: ${phrase ?? "verification"}`) };
    }
    // A bare refusal with no body: nothing to wait on and nothing to solve.
    if ((probe.status === 403 || probe.status === 451) && text.trim().length < 300) {
      return { vendor: "generic", kind: "block", reason: `status ${probe.status}` };
    }
  }
  return undefined;
}

/** One line for the agent: a `CHALLENGE:`/`BLOCKED:` verdict with the recommended next step. */
export function describeChallenge(detection: ChallengeDetection, url: string): string {
  const where = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return url;
    }
  })();
  const label = `${detection.vendor} ${detection.kind} challenge on ${where} (${detection.reason})`;
  if (detection.kind === "block") {
    return `BLOCKED: ${where} refused the visit; ${detection.vendor} (${detection.reason}). Do not retry or reload in a loop: it makes the block worse for the user's IP. Stop and tell the user.`;
  }
  if (detection.kind === "interactive") {
    return `CHALLENGE: ${label}. A person has to answer it: call handoff("Solve the security check on ${where}, then continue"). Do not retry or reload in a loop.`;
  }
  return `CHALLENGE: ${label}. It should clear by itself: wait briefly, then re-read the page.`;
}
