import { describe, expect, test } from "bun:test";
import {
  classifyChallenge,
  describeChallenge,
  probeSelectors,
  type ChallengeDetection,
  type ChallengeProbe,
} from "../src/challenges";

/** Fill the non-signal fields so each case names only what it is about. */
function probe(overrides: Partial<ChallengeProbe> = {}): ChallengeProbe {
  return {
    url: "https://shop.example/",
    title: "",
    text: "",
    frameUrls: [],
    scriptSrcs: [],
    selectors: [],
    visibleSelectors: [],
    ...overrides,
  };
}

const expectKind = (detection: ChallengeDetection | undefined, kind: ChallengeDetection["kind"]) => {
  expect(detection).toBeDefined();
  expect(detection?.kind).toBe(kind);
};

describe("classifyChallenge: cloudflare", () => {
  test("the managed challenge is non-interactive until Turnstile shows a widget", () => {
    const waiting = probe({
      title: "Just a moment...",
      text: "Checking if the site connection is secure",
      selectors: ["#challenge-running"],
    });
    expect(classifyChallenge(waiting)).toMatchObject({ vendor: "cloudflare", kind: "non-interactive" });

    const widget = probe({
      title: "Just a moment...",
      text: "Verify you are human by completing the action below.",
      frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc"],
      selectors: [".cf-turnstile"],
      visibleSelectors: [".cf-turnstile"],
    });
    expect(classifyChallenge(widget)).toMatchObject({ vendor: "cloudflare", kind: "interactive" });
  });

  test("the languages' interstitials and challenge frames", () => {
    expect(classifyChallenge(probe({ title: "Un instant…" }))).toMatchObject({ vendor: "cloudflare" });
    expect(classifyChallenge(probe({ title: "Einen Moment bitte…" }))).toMatchObject({ vendor: "cloudflare" });
    expect(
      classifyChallenge(
        probe({ frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/g/orchestrate/chl/abc"] }),
      ),
    ).toMatchObject({ vendor: "cloudflare", kind: "non-interactive" });
  });

  test("a hard block", () => {
    const blocked = probe({
      title: "Attention Required! | Cloudflare",
      text: "Sorry, you have been blocked. Cloudflare Ray ID: 1",
      selectors: ["#cf-error-details"],
    });
    expect(classifyChallenge(blocked)).toMatchObject({ vendor: "cloudflare", kind: "block" });
  });
});

describe("classifyChallenge: akamai", () => {
  test("the silent interstitial", () => {
    const waiting = probe({ selectors: ["#sec-if-cpt-container"], text: "Please wait while we verify" });
    expect(classifyChallenge(waiting)).toMatchObject({ vendor: "akamai", kind: "non-interactive" });
  });

  test("the visible captcha is interactive", () => {
    const captcha = probe({
      selectors: ["#sec-cpt-if"],
      visibleSelectors: ["#sec-cpt-if"],
      text: "Slide to verify you are human",
    });
    expect(classifyChallenge(captcha)).toMatchObject({ vendor: "akamai", kind: "interactive" });
  });

  test("the Access Denied block", () => {
    const blocked = probe({
      title: "Access Denied",
      text: 'Access Denied\nYou don\'t have permission to access "http://shop.example/" on this server.\nReference #18.abc.1700000000.1',
    });
    expect(classifyChallenge(blocked)).toMatchObject({ vendor: "akamai", kind: "block" });
  });
});

describe("classifyChallenge: datadome", () => {
  test("the captcha frame is interactive", () => {
    const captcha = probe({ frameUrls: ["https://geo.captcha-delivery.com/captcha/?initialCid=x"] });
    expect(classifyChallenge(captcha)).toMatchObject({ vendor: "datadome", kind: "interactive" });
  });

  test("the device-check interstitial is non-interactive", () => {
    const check = probe({ frameUrls: ["https://geo.captcha-delivery.com/interstitial/?initialCid=x"] });
    expect(classifyChallenge(check)).toMatchObject({ vendor: "datadome", kind: "non-interactive" });
  });

  test("the container element", () => {
    expect(classifyChallenge(probe({ selectors: ["#ddv1-captcha-container"] }))).toMatchObject({
      vendor: "datadome",
      kind: "interactive",
    });
  });
});

describe("classifyChallenge: perimeterx", () => {
  test("Press & Hold is interactive", () => {
    const press = probe({
      selectors: ["#px-captcha"],
      text: "Press & Hold to confirm you are a human (and not a bot).",
    });
    expect(classifyChallenge(press)).toMatchObject({ vendor: "perimeterx", kind: "interactive" });
  });

  test("the phrase alone counts", () => {
    expect(classifyChallenge(probe({ text: "Before we continue, press and hold." }))).toMatchObject({
      vendor: "perimeterx",
      kind: "interactive",
    });
  });
});

describe("classifyChallenge: imperva", () => {
  test("the resource wait is non-interactive", () => {
    const waiting = probe({ frameUrls: ["https://shop.example/_Incapsula_Resource?SWUDNSAI=1"] });
    expect(classifyChallenge(waiting)).toMatchObject({ vendor: "imperva", kind: "non-interactive" });
    expect(classifyChallenge(probe({ scriptSrcs: ["https://shop.example/_Incapsula_Resource?x"] }))).toMatchObject({
      vendor: "imperva",
      kind: "non-interactive",
    });
  });

  test("a captcha inside the resource wait is interactive", () => {
    const captcha = probe({
      frameUrls: ["https://shop.example/_Incapsula_Resource?SWUDNSAI=1"],
      text: "Please complete the captcha",
    });
    expect(classifyChallenge(captcha)).toMatchObject({ vendor: "imperva", kind: "interactive" });
  });

  test("the incident-id block", () => {
    const blocked = probe({
      scriptSrcs: ["https://shop.example/_Incapsula_Resource?x"],
      text: "Request unsuccessful. Incapsula incident ID: 1-2",
    });
    expect(classifyChallenge(blocked)).toMatchObject({ vendor: "imperva", kind: "block" });
    expect(
      classifyChallenge(probe({ title: "Error", text: "Incapsula incident ID: 1234-5678" })),
    ).toMatchObject({ vendor: "imperva", kind: "block" });
  });
});

describe("classifyChallenge: aws-waf", () => {
  test("the captcha widget is interactive", () => {
    expect(classifyChallenge(probe({ selectors: ["awswaf-captcha"] }))).toMatchObject({
      vendor: "aws-waf",
      kind: "interactive",
    });
    expect(classifyChallenge(probe({ selectors: ["#captcha-container awswaf-captcha"] }))).toMatchObject({
      vendor: "aws-waf",
      kind: "interactive",
    });
  });

  test("the silent challenge script is non-interactive", () => {
    const challenge = probe({
      url: "https://shop.example/",
      title: "",
      text: "One moment",
      scriptSrcs: ["https://abc123.edge.sdk.awswaf.com/abc/challenge.js"],
    });
    expect(classifyChallenge(challenge)).toMatchObject({ vendor: "aws-waf", kind: "non-interactive" });
  });

  test("the challenge script on a content page is not a challenge", () => {
    const page = probe({
      title: "Checkout",
      text: `Your cart is ready. ${"Item details. ".repeat(200)}`,
      scriptSrcs: ["https://abc123.edge.sdk.awswaf.com/abc/challenge.js"],
    });
    expect(classifyChallenge(page)).toBeUndefined();
  });
});

describe("classifyChallenge: recaptcha and hcaptcha", () => {
  test("a reCAPTCHA wall is interactive", () => {
    const wall = probe({
      text: "Our systems have detected unusual traffic",
      frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"],
    });
    expect(classifyChallenge(wall)).toMatchObject({ vendor: "recaptcha", kind: "interactive" });
  });

  test("the enterprise frame counts too", () => {
    const wall = probe({
      title: "Security check",
      frameUrls: ["https://www.recaptcha.net/recaptcha/enterprise/anchor?k=x"],
    });
    expect(classifyChallenge(wall)).toMatchObject({ vendor: "recaptcha", kind: "interactive" });
  });

  test("Google's sorry interstitial", () => {
    const sorry = probe({ url: "https://www.google.com/sorry/index?continue=x", title: "" });
    expect(classifyChallenge(sorry)).toMatchObject({ vendor: "recaptcha", kind: "interactive" });
  });

  test("an hCaptcha wall is interactive", () => {
    const wall = probe({
      text: "Please verify you are a human",
      frameUrls: ["https://newassets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html#frame=checkbox"],
    });
    expect(classifyChallenge(wall)).toMatchObject({ vendor: "hcaptcha", kind: "interactive" });
    const assets = probe({
      text: "Please verify you are a human",
      frameUrls: ["https://assets.hcaptcha.com/captcha/v1/abc/static/hcaptcha.html"],
    });
    expect(classifyChallenge(assets)).toMatchObject({ vendor: "hcaptcha", kind: "interactive" });
  });
});

describe("classifyChallenge: generic", () => {
  test("a refusal is a block", () => {
    expect(classifyChallenge(probe({ title: "Access Denied", text: "Access denied" }))).toMatchObject({
      vendor: "generic",
      kind: "block",
    });
    expect(classifyChallenge(probe({ title: "403 Forbidden", text: "" }))).toMatchObject({
      vendor: "generic",
      kind: "block",
    });
    expect(classifyChallenge(probe({ text: "Access to this page has been denied." }))).toMatchObject({
      vendor: "generic",
      kind: "block",
    });
  });

  test("a bare 403 or 451 refusal is a block", () => {
    expect(classifyChallenge(probe({ status: 403, text: "" }))).toMatchObject({ vendor: "generic", kind: "block" });
    expect(classifyChallenge(probe({ status: 451, title: "Unavailable" }))).toMatchObject({
      vendor: "generic",
      kind: "block",
    });
    expect(classifyChallenge(probe({ status: 500, text: "" }))).toBeUndefined();
    expect(classifyChallenge(probe({ status: 200, text: "" }))).toBeUndefined();
  });

  test("a verification page is interactive", () => {
    expect(
      classifyChallenge(probe({ title: "Security", text: "Please verify you are a human to continue." })),
    ).toMatchObject({ vendor: "generic", kind: "interactive" });
    expect(classifyChallenge(probe({ title: "Pardon our interruption", text: "" }))).toMatchObject({
      vendor: "generic",
      kind: "interactive",
    });
    expect(classifyChallenge(probe({ text: "Are you a robot? Choose the right picture." }))).toMatchObject({
      vendor: "generic",
      kind: "interactive",
    });
  });
});

describe("classifyChallenge: pages that must not be flagged", () => {
  test("generic phrases count only on short pages", () => {
    const article = `How bot detection works: sites ask you to verify you are human. ${"Long article text. ".repeat(200)}`;
    const long = probe({ title: "Bot detection explained", text: article.slice(0, 3000), textLength: article.length });
    expect(classifyChallenge(long)).toBeUndefined();
  });

  test("textLength falls back to the text sample when omitted", () => {
    const long = probe({
      title: "Access denied: a history",
      text: `Access denied pages are old. ${"Long article text. ".repeat(200)}`,
    });
    expect(classifyChallenge(long)).toBeUndefined();
  });

  test("a login form with an embedded reCAPTCHA is not a wall", () => {
    const login = probe({
      title: "Sign in",
      text: "Email\nPassword\nSign in\nRemember me",
      frameUrls: ["https://www.google.com/recaptcha/api2/anchor?k=x"],
      selectors: [".g-recaptcha"],
      visibleSelectors: [".g-recaptcha"],
    });
    expect(classifyChallenge(login)).toBeUndefined();
  });

  test("a Turnstile widget on a long form is not a challenge page", () => {
    const form = probe({
      title: "Contact us",
      text: `Send us a message. ${"Our address and hours. ".repeat(200)}`,
      frameUrls: ["https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv/abc"],
      selectors: [".cf-turnstile"],
      visibleSelectors: [".cf-turnstile"],
    });
    expect(classifyChallenge(form)).toBeUndefined();
  });

  test("an ordinary page", () => {
    expect(
      classifyChallenge(probe({ title: "Example Domain", text: "This domain is for use in documentation examples." })),
    ).toBeUndefined();
    expect(classifyChallenge({ url: "not a url", title: "", text: "" })).toBeUndefined();
    expect(classifyChallenge({ url: "https://example.com/", title: "", text: "" })).toBeUndefined();
  });

  test("the selector list covers every vendor family", () => {
    const listed: readonly string[] = probeSelectors;
    for (const selector of [
      "#challenge-form",
      "#sec-if-cpt-container",
      "#ddv1-captcha-container",
      "#px-captcha",
      "awswaf-captcha",
      ".g-recaptcha",
      ".h-captcha",
    ]) {
      expect(listed).toContain(selector);
    }
  });
});

describe("describeChallenge", () => {
  test("names the vendor, origin, and the next step for each kind", () => {
    const base = { vendor: "cloudflare" as const, reason: "title: Just a moment..." };
    const nonInteractive = describeChallenge({ ...base, kind: "non-interactive" }, "https://shop.example/a?b");
    expect(nonInteractive).toStartWith("CHALLENGE:");
    expect(nonInteractive).toContain("clear by itself");

    const interactive = describeChallenge({ ...base, kind: "interactive" }, "https://shop.example/a?b");
    expect(interactive).toContain('handoff("Solve the security check on https://shop.example');
    expect(interactive).toContain("cloudflare interactive challenge");

    const blocked = describeChallenge({ ...base, kind: "block" }, "https://shop.example/a?b");
    expect(blocked).toStartWith("BLOCKED:");
    expect(blocked).toContain("Do not retry");
  });

  test("keeps an unparseable URL as given", () => {
    expect(describeChallenge({ vendor: "generic", kind: "block", reason: "status 403" }, "not a url")).toContain(
      "not a url",
    );
  });
});
