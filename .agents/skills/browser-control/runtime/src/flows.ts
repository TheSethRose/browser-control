/**
 * Read-only saved GET flows:
 * Record first-party 2xx GET JSON endpoints observed during browsing, parameterize typed values
 * into {{param}}, store cleanly without credentials/cookies, and replay via in-tab fetch() with
 * response shape-drift detection and --fields / --where / --limit filtering.
 */
import { existsSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const SECRET_KEY = /token|key|sig|session|password|passwd|secret|csrf|auth|otp|pin|cvv|cvc|card|cookie/i;

export type RecordedGet = {
  id: string;
  url: string;
  origin: string;
  status: number;
  body: unknown;
  at: number;
};

export type SavedFlow = {
  version: 1;
  name: string;
  site: string;
  origin: string;
  method: "GET";
  urlTemplate: string;
  params: Array<{ name: string; example?: string }>;
  listPath: string | null;
  shapeKeys: string[];
  createdAt: string;
  verified: boolean;
};

export function defaultFlowsDir(): string {
  const cfg = process.env["XDG_CONFIG_HOME"] || join(homedir(), ".config");
  return join(cfg, "browser-control", "flows");
}

function safeName(name: string): string {
  const s = name.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(s)) {
    throw new Error(`INPUT_INVALID: flow name must match [a-zA-Z0-9._-], got "${name}"`);
  }
  return s;
}

function safeSite(host: string): string {
  const s = host.trim().toLowerCase().replace(/:/g, "_");
  if (!/^[a-z0-9._-]+$/.test(s) || s.includes("..")) {
    throw new Error(`INPUT_INVALID: unsafe site "${host}"`);
  }
  return s;
}

/** Reject URLs carrying credential query keys or unsafe schemes. */
export function validateFlowUrl(raw: string): URL {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new Error(`REFUSED: flow URL must be http or https`);
  }
  if (u.username || u.password) throw new Error(`REFUSED: flow URL cannot carry user info`);
  for (const [k] of u.searchParams) {
    if (SECRET_KEY.test(k)) throw new Error(`REFUSED: flow URL contains credential query parameter "${k}"`);
  }
  return u;
}

/** Find the largest array of objects inside a JSON value and record its dotted path + keys. */
export function inferShape(body: unknown): { listPath: string | null; shapeKeys: string[] } {
  let bestPath: string | null = null;
  let bestArr: unknown[] | null = null;
  const walk = (val: unknown, path: string, depth: number) => {
    if (depth > 4 || val === null || typeof val !== "object") return;
    if (Array.isArray(val)) {
      if (val.length > 0 && typeof val[0] === "object" && val[0] !== null && !Array.isArray(val[0])) {
        if (!bestArr || val.length > bestArr.length) {
          bestArr = val;
          bestPath = path;
        }
      }
      return;
    }
    for (const [k, v] of Object.entries(val as Record<string, unknown>)) {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)) continue;
      walk(v, path ? `${path}.${k}` : k, depth + 1);
    }
  };
  walk(body, "", 0);
  if (bestArr && (bestArr as unknown[]).length > 0) {
    const sample = (bestArr as Record<string, unknown>[])[0]!;
    const keys = Object.keys(sample).filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)).slice(0, 30);
    return { listPath: bestPath, shapeKeys: keys };
  }
  if (body && typeof body === "object" && !Array.isArray(body)) {
    const keys = Object.keys(body as Record<string, unknown>).filter((k) => /^[A-Za-z_][A-Za-z0-9_]{0,31}$/.test(k)).slice(0, 30);
    return { listPath: null, shapeKeys: keys };
  }
  return { listPath: null, shapeKeys: [] };
}

export function extractByPath(body: unknown, path: string | null): unknown {
  if (!path) return body;
  let cur: any = body;
  for (const part of path.split(".")) {
    if (cur === null || cur === undefined || typeof cur !== "object") return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Build a parameterized SavedFlow from a recorded GET JSON response and optional param map. */
export function buildFlow(
  name: string,
  rec: RecordedGet,
  paramMap: Record<string, string> = {},
): SavedFlow {
  const u = validateFlowUrl(rec.url);
  let template = `${u.origin}${u.pathname}${u.search}`;
  const params: Array<{ name: string; example?: string }> = [];
  for (const [k, v] of Object.entries(paramMap)) {
    if (!/^[a-zA-Z_][a-zA-Z0-9_]{0,23}$/.test(k)) {
      throw new Error(`INPUT_INVALID: invalid param name "${k}"`);
    }
    if (!v || v.length < 2) continue;
    const encoded = encodeURIComponent(v);
    if (template.includes(encoded) || template.includes(v)) {
      template = template.split(encoded).join(`{{${k}}}`).split(v).join(`{{${k}}}`);
      params.push({ name: k, example: SECRET_KEY.test(k) ? undefined : v.slice(0, 40) });
    }
  }
  const { listPath, shapeKeys } = inferShape(rec.body);
  return {
    version: 1,
    name: safeName(name),
    site: u.host.toLowerCase(),
    origin: u.origin,
    method: "GET",
    urlTemplate: template,
    params,
    listPath,
    shapeKeys,
    createdAt: new Date().toISOString(),
    verified: true,
  };
}

/** Substitute {{params}} into a flow URL template and verify the resulting URL stays on the flow's origin. */
export function fillFlowUrl(flow: SavedFlow, given: Record<string, string> = {}): string {
  const validNames = new Set(flow.params.map((p) => p.name));
  for (const k of Object.keys(given)) {
    if (!validNames.has(k)) {
      throw new Error(`INPUT_INVALID: unknown flow param "${k}". Expected: ${[...validNames].join(", ") || "(none)"}`);
    }
  }
  let url = flow.urlTemplate;
  for (const p of flow.params) {
    const val = given[p.name] ?? p.example;
    if (val === undefined) throw new Error(`INPUT_INVALID: missing required flow param "${p.name}"`);
    url = url.split(`{{${p.name}}}`).join(encodeURIComponent(val));
  }
  const parsed = validateFlowUrl(url);
  if (parsed.origin !== flow.origin) {
    throw new Error(`REFUSED: filled URL origin ${parsed.origin} leaves flow origin ${flow.origin}`);
  }
  return parsed.href;
}

/** Filter and shape a flow's JSON response with drift detection. */
export function shapeFlowResult(
  flow: SavedFlow,
  body: unknown,
  opts: { fields?: string[]; where?: Record<string, string>; limit?: number } = {},
): { drifted: boolean; missingKeys: string[]; text: string } {
  const target = extractByPath(body, flow.listPath);
  if (flow.listPath && !Array.isArray(target)) {
    return {
      drifted: true,
      missingKeys: [flow.listPath],
      text: `FLOW_DRIFTED: expected array at "${flow.listPath}" in ${flow.name}; drive the page instead`,
    };
  }
  if (Array.isArray(target)) {
    const sample = target[0] && typeof target[0] === "object" ? (target[0] as Record<string, unknown>) : null;
    const missingKeys = sample ? flow.shapeKeys.filter((k) => !(k in sample)) : [];
    const drifted = sample !== null && flow.shapeKeys.length > 0 && missingKeys.length === flow.shapeKeys.length;
    let items = target as Array<Record<string, unknown>>;
    if (opts.where) {
      for (const [field, needle] of Object.entries(opts.where)) {
        const want = needle.toLowerCase();
        items = items.filter((item) => String(extractByPath(item, field) ?? "").toLowerCase().includes(want));
      }
    }
    const matched = items.length;
    if (opts.limit && opts.limit > 0) items = items.slice(0, opts.limit);
    if (opts.fields && opts.fields.length > 0) {
      items = items.map((item) => {
        const row: Record<string, unknown> = {};
        for (const f of opts.fields!) row[f] = extractByPath(item, f);
        return row;
      });
    }
    const head = `# flow ${flow.name}: ${items.length} of ${matched} matched (${target.length} total${flow.listPath ? ` in ${flow.listPath}` : ""})${drifted ? " [DRIFTED]" : ""}`;
    return { drifted, missingKeys, text: [head, ...items.map((i) => JSON.stringify(i))].join("\n") };
  }
  const text = `# flow ${flow.name}\n${JSON.stringify(target ?? body, null, 2).slice(0, 12000)}`;
  return { drifted: false, missingKeys: [], text };
}

export async function saveFlowFile(flow: SavedFlow, dir = defaultFlowsDir()): Promise<string> {
  const siteDir = join(dir, safeSite(flow.site));
  await mkdir(siteDir, { recursive: true, mode: 0o700 });
  await chmod(siteDir, 0o700).catch(() => {});
  const filePath = join(siteDir, `${safeName(flow.name)}.json`);
  const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(flow, null, 2)}\n`, { mode: 0o600 });
  await chmod(tmp, 0o600).catch(() => {});
  await rename(tmp, filePath);
  return filePath;
}

export async function loadFlowFile(name: string, site?: string, dir = defaultFlowsDir()): Promise<SavedFlow> {
  const n = safeName(name);
  if (site) {
    const filePath = join(dir, safeSite(site), `${n}.json`);
    if (!existsSync(filePath)) throw new Error(`NO_MATCH: no flow "${n}" for site "${site}"`);
    return JSON.parse(await readFile(filePath, "utf8")) as SavedFlow;
  }
  if (!existsSync(dir)) throw new Error(`NO_MATCH: no saved flow "${n}"`);
  const sites = await readdir(dir);
  const hits: string[] = [];
  for (const s of sites) {
    const p = join(dir, s, `${n}.json`);
    if (existsSync(p)) hits.push(p);
  }
  if (hits.length === 0) throw new Error(`NO_MATCH: no saved flow "${n}"`);
  if (hits.length > 1) throw new Error(`AMBIGUOUS: flow "${n}" exists for multiple sites; pass --site`);
  return JSON.parse(await readFile(hits[0]!, "utf8")) as SavedFlow;
}

export async function listFlows(site?: string, dir = defaultFlowsDir()): Promise<string> {
  if (!existsSync(dir)) return "# no saved flows";
  const sites = site ? [safeSite(site)] : (await readdir(dir)).sort();
  const lines: string[] = [];
  for (const s of sites) {
    const siteDir = join(dir, s);
    if (!existsSync(siteDir)) continue;
    const files = (await readdir(siteDir)).filter((f) => f.endsWith(".json")).sort();
    for (const f of files) {
      try {
        const flow = JSON.parse(await readFile(join(siteDir, f), "utf8")) as SavedFlow;
        const pList = flow.params.map((p) => p.name).join(", ");
        lines.push(`- ${flow.site} :: ${flow.name}(${pList}) -> ${flow.urlTemplate}`);
      } catch { /* skip malformed */ }
    }
  }
  return lines.length ? [`# ${lines.length} saved flow(s):`, ...lines].join("\n") : "# no saved flows";
}

export async function removeFlowFile(name: string, site?: string, dir = defaultFlowsDir()): Promise<string> {
  const flow = await loadFlowFile(name, site, dir);
  const filePath = join(dir, safeSite(flow.site), `${safeName(flow.name)}.json`);
  await rm(filePath, { force: true });
  return `removed flow ${flow.name} (${flow.site})`;
}
