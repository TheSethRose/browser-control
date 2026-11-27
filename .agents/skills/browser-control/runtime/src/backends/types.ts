/**
 * Backends: other ways to reach the browser besides the built-in DevTools (CDP) connection.
 *
 * The CDP operations in `src/index.ts` are always present for v1 users, explicit CDP requests,
 * and opt-in fallback orders (such as `extension,cdp`). Each extra backend lives in its own
 * file, is listed once in `./registry`, and can be removed by deleting that line and its file.
 * Nothing else in the runtime imports a backend directly.
 */

export type OpInput = Record<string, unknown>;

/** A tab as `list_targets` reports it. Backend tabs carry a `<backend>:` id prefix. */
export type BackendTarget = {
  targetId: string;
  type: "page";
  title: string;
  url: string;
  backend: string;
};

export interface Backend {
  /** Short id, also the prefix of this backend's target ids (`browse:123`). */
  readonly name: string;
  /**
   * Whether this backend runs `op` for `input`. `active` is true when this backend owns the
   * current tab. Returning false hands the operation to the next backend in the order.
   */
  handles(op: string, input: OpInput, active: boolean): boolean;
  /** Run the operation. Throw `BackendUnavailable` to pass to the next backend (if one is configured). */
  invoke(op: string, input: OpInput): Promise<unknown>;
  /** Tabs this backend can act on, for `list_targets`. */
  listTargets(): Promise<BackendTarget[]>;
  /** A small status object for `get_browser_status`. Must not throw. */
  status(): Promise<Record<string, unknown>>;
  /** Forget the selected tab. */
  clearActive(): void;
  /** Whether a tab is selected (optional; assumed true when missing). */
  hasActive?(): boolean;
  /** Optional startup hook (called when this backend is enabled in backendOrder). */
  start?(): Promise<void> | void;
  dispose?(): Promise<void> | void;
}

/** The backend can't serve this call right now (not installed, no browser connected). */
export class BackendUnavailable extends Error {
  constructor(backend: string, reason: string) {
    super(`BACKEND_UNAVAILABLE: ${backend}: ${reason}`);
    this.name = "BackendUnavailable";
  }
}

export function prefixOf(targetId: unknown): string | undefined {
  if (typeof targetId !== "string") return undefined;
  const i = targetId.indexOf(":");
  return i > 0 ? targetId.slice(0, i) : undefined;
}
