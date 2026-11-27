#!/usr/bin/env bun
// Thin standalone CLI bootstrap. All behavior lives in the shared capability
// implementation and the reusable core adapter. `--serve <socket>` runs the
// long-lived daemon instead of one CLI invocation.
import { join } from "node:path";
import { runStandaloneCapabilityCli } from "@agent-software/core";
import { serveDaemon } from "./daemon";
import { createPairingCode, setupExtensionPairing } from "./src/backends/extension";

const args = process.argv.slice(2);
const [flag, arg] = args;
if (flag === "--serve" && arg) {
  await serveDaemon(import.meta.dir, arg);
} else if (flag === "extension-setup") {
  const extDir = arg || join(import.meta.dir, "extension");
  const result = await setupExtensionPairing(extDir);
  console.log(JSON.stringify(result));
} else if (flag === "extension-pair") {
  let port: number | undefined;
  let ttlMs: number | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === "--port" && args[i + 1]) {
      const parsed = Number(args[++i]);
      if (Number.isInteger(parsed) && parsed > 0 && parsed <= 65535) port = parsed;
    } else if (a === "--ttl" && args[i + 1]) {
      const parsed = Number(args[++i]);
      if (Number.isFinite(parsed) && parsed > 0) ttlMs = parsed * 1000;
    }
  }
  const result = await createPairingCode({ port, ttlMs });
  console.log(JSON.stringify(result));
} else {
  process.exit(await runStandaloneCapabilityCli(import.meta.dir));
}
