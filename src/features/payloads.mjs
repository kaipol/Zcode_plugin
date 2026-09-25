// Payload resolver. Payloads live as real files under src/features/ (so
// `node --check` can gate their syntax) both in the source tree and inside
// the self-extracting dist, which unpacks the whole tree before running.
// The embedded map (filled only if a future build inlines payloads) takes
// precedence when present.
import fs from "node:fs";
import { EMBEDDED_PAYLOADS } from "./payloads.embedded.mjs";

export function payloadText(rel) {
  if (Object.prototype.hasOwnProperty.call(EMBEDDED_PAYLOADS, rel)) {
    return EMBEDDED_PAYLOADS[rel];
  }
  return fs.readFileSync(new URL(`./${rel}`, import.meta.url), "utf8");
}
