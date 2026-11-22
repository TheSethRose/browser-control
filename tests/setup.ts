// Tests must not depend on the machine's backend config or drive a real browse extension.
process.env["BROWSER_CONTROL_BACKENDS"] = "cdp";
