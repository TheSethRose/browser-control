// Mutual HMAC-SHA256 pairing helpers for Browser Control Companion (MV3 Web Crypto).
// Mutual challenge-response handshake pattern adapted from anomalyco/browse (MIT License).

export const PROTOCOL_VERSION = 1;

const HEX_32_RE = /^[0-9a-f]{32}$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/i;
const encoder = new TextEncoder();

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

export function randomNonceHex(byteLength = 16) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return toHex(bytes);
}

export function isValidNonceHex(value) {
  return typeof value === "string" && HEX_32_RE.test(value);
}

export function relayProofMessage(port, extNonce, relayNonce) {
  return `bc-v2|relay|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function extProofMessage(port, relayNonce, extNonce) {
  return `bc-v2|ext|127.0.0.1:${port}/extension|${relayNonce}|${extNonce}`;
}

export async function hmacHex(token, message) {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(String(token)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(String(message)));
  return toHex(new Uint8Array(sig));
}

export async function verifyHmacHex(token, message, actualHex) {
  if (typeof actualHex !== "string" || !HEX_64_RE.test(actualHex)) return false;
  const expected = await hmacHex(token, message);
  const actual = actualHex.toLowerCase();
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
}

export async function getOrCreateProfileId() {
  const stored = await chrome.storage.local.get(["profileId"]);
  if (typeof stored.profileId === "string" && stored.profileId.trim() !== "") {
    return stored.profileId;
  }
  const profileId = crypto.randomUUID();
  await chrome.storage.local.set({ profileId });
  return profileId;
}

export function detectBrowserBrand() {
  const brands = navigator.userAgentData?.brands;
  if (Array.isArray(brands)) {
    const names = brands.map((b) => String(b?.brand || ""));
    if (names.some((n) => /brave/i.test(n))) return "Brave";
    if (names.some((n) => /edge/i.test(n))) return "Edge";
    if (names.some((n) => /opera/i.test(n))) return "Opera";
    if (names.some((n) => /vivaldi/i.test(n))) return "Vivaldi";
    if (names.some((n) => /google chrome/i.test(n))) return "Chrome";
  }
  const ua = navigator.userAgent || "";
  if (/Edg\//.test(ua)) return "Edge";
  if (/OPR\//.test(ua)) return "Opera";
  if (/Vivaldi\//.test(ua)) return "Vivaldi";
  if (/Chrome\//.test(ua)) return "Chrome";
  return "Chromium";
}
