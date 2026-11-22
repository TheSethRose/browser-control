/**
 * The extra backends this runtime knows. Add one: write `./<name>.ts` implementing
 * `Backend` and list it here. Remove one: delete its line and its file.
 */

import { createBrowseBackend } from "./browse";
import type { Backend } from "./types";

export function createBackends(): Backend[] {
  return [createBrowseBackend()];
}
