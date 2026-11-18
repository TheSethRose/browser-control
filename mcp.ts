#!/usr/bin/env bun
// Thin standalone MCP bootstrap. Exposes only this capability's operations,
// using plain operation names. All behavior lives in the shared implementation.
import { openStandaloneCapability, serveCapabilityMcpStdio } from "@agent-software/core";

const capability = await openStandaloneCapability(import.meta.dir);
await serveCapabilityMcpStdio(capability);
