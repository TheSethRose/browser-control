// Tests must not depend on the machine's backend or natural-browsing config or drive a real browser extension.
process.env["BROWSER_CONTROL_BACKENDS"] = "cdp";
process.env["BROWSER_CONTROL_NATURAL"] = "off";
