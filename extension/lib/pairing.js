// Mutual HMAC-SHA256, AES-256-GCM token unwrapping, and ephemeral P-256 ECDH + PBKDF2
// one-time code pairing helpers for Browser Control Companion (MV3 Web Crypto).
// Mutual challenge-response handshake pattern adapted from anomalyco/browse (MIT License).

export const PROTOCOL_VERSION = 1;
export const CROCKFORD_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
export const PAIR_PBKDF2_MIN_ITERATIONS = 10_000;
export const PAIR_PBKDF2_MAX_ITERATIONS = 1_000_000;

const HEX_32_RE = /^[0-9a-f]{32}$/i;
const HEX_64_RE = /^[0-9a-f]{64}$/i;
const CROCKFORD_8_RE = /^[0-9A-HJKMNP-TV-Z]{8}$/;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function toHex(bytes) {
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function fromHex(hex) {
  const clean = String(hex || "");
  if (clean.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(clean)) {
    throw new Error("invalid hex string");
  }
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) {
    bin += String.fromCharCode(bytes[i]);
  }
  return btoa(bin);
}

function fromBase64(b64) {
  const bin = atob(String(b64 || ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) {
    out[i] = bin.charCodeAt(i);
  }
  return out;
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

function constantTimeEqualHex(expectedHex, actualHex) {
  if (typeof actualHex !== "string" || !HEX_64_RE.test(actualHex)) return false;
  const expected = expectedHex.toLowerCase();
  const actual = actualHex.toLowerCase();
  if (expected.length !== actual.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) {
    diff |= expected.charCodeAt(i) ^ actual.charCodeAt(i);
  }
  return diff === 0;
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

export function wrapInfoMessage(port, extNonce, relayNonce) {
  return `bc-v2|wrap|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function pairKeyInfoMessage(port, extNonce, relayNonce, extPubB64, relayPubB64) {
  return `bc-v2|pair-key|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairExtProofMessage(port, relayNonce, extNonce, extPubB64, relayPubB64) {
  return `bc-v2|pair-ext|127.0.0.1:${port}/extension|${relayNonce}|${extNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairRelayProofMessage(port, extNonce, relayNonce, extPubB64, relayPubB64) {
  return `bc-v2|pair-relay|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}|${extPubB64}|${relayPubB64}`;
}

export function pairWrapInfoMessage(port, extNonce, relayNonce) {
  return `bc-v2|pair-wrap|127.0.0.1:${port}/extension|${extNonce}|${relayNonce}`;
}

export function wrapAadMessage(profileId, tokenId) {
  return `bc-v2|token|${profileId}|${tokenId}`;
}

export async function hmacHex(token, message) {
  const keyBytes = typeof token === "string" ? encoder.encode(token) : token;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
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
  return constantTimeEqualHex(expected, actualHex);
}

/** Normalize a Crockford Base32 8-character pairing code, returning null if malformed. */
export function normalizePairingCode(raw) {
  const cleaned = String(raw || "")
    .toUpperCase()
    .replace(/[\s-]+/g, "")
    .replace(/O/g, "0")
    .replace(/[IL]/g, "1");
  return CROCKFORD_8_RE.test(cleaned) ? cleaned : null;
}

/** Format an 8-character Crockford code as `XXXX-XXXX`. */
export function formatPairingCode(raw) {
  const norm = normalizePairingCode(raw);
  if (!norm) throw new Error("invalid pairing code");
  return `${norm.slice(0, 4)}-${norm.slice(4)}`;
}

/**
 * Choose which credential to authenticate with, given chrome.storage.local (`stored`)
 * and optional unpacked `pairing.json` (`fileCfg`).
 *
 * A newer `pairing.json` (`pairingId` changed or absent on stored token) always wins over
 * a stored per-browser token so re-running `extension-setup` rotates cleanly.
 */
export function selectAuthCredentials(stored = {}, fileCfg = null, defaultPort = 49222) {
  const fileToken = typeof fileCfg?.token === "string" ? fileCfg.token.trim() : "";
  const filePairingId = typeof fileCfg?.pairingId === "string" ? fileCfg.pairingId.trim() : "";
  const storedBrowserToken = typeof stored?.browserToken === "string" ? stored.browserToken.trim() : "";
  const storedBrowserTokenId = typeof stored?.browserTokenId === "string" ? stored.browserTokenId.trim() : "";
  const storedPairingId = typeof stored?.pairingId === "string" ? stored.pairingId.trim() : "";
  const storedLegacyToken = typeof stored?.token === "string" ? stored.token.trim() : "";
  const port = Number(fileCfg?.port || stored?.port || defaultPort);

  if (fileToken) {
    const pairingMatches =
      Boolean(storedBrowserToken) &&
      Boolean(storedBrowserTokenId) &&
      Boolean(filePairingId) &&
      storedPairingId === filePairingId;
    if (pairingMatches) {
      return {
        port,
        mode: "browser",
        token: storedBrowserToken,
        tokenId: storedBrowserTokenId,
        pairingId: filePairingId,
      };
    }
    return {
      port,
      mode: "bootstrap",
      token: fileToken,
      tokenId: undefined,
      pairingId: filePairingId || undefined,
    };
  }

  if (storedBrowserToken && storedBrowserTokenId) {
    return {
      port,
      mode: "browser",
      token: storedBrowserToken,
      tokenId: storedBrowserTokenId,
      pairingId: storedPairingId || undefined,
    };
  }

  if (storedLegacyToken) {
    return {
      port,
      mode: "bootstrap",
      token: storedLegacyToken,
      tokenId: undefined,
      pairingId: storedPairingId || undefined,
    };
  }

  return {
    port,
    mode: "none",
    token: "",
    tokenId: undefined,
    pairingId: undefined,
  };
}

async function hkdfBits(ikmBytes, info, bitLength = 256) {
  const baseKey = await crypto.subtle.importKey("raw", ikmBytes, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    {
      name: "HKDF",
      hash: "SHA-256",
      salt: new Uint8Array(0),
      info: encoder.encode(info),
    },
    baseKey,
    bitLength,
  );
  return new Uint8Array(bits);
}

/**
 * Unwrap an AES-256-GCM wrapped per-browser token sent in `welcome.wrappedToken`.
 */
export async function unwrapBrowserToken({ wrappedToken, ikm, info, profileId }) {
  if (!wrappedToken || typeof wrappedToken !== "object") {
    throw new Error("missing wrappedToken");
  }
  const { tokenId, iv, ciphertext } = wrappedToken;
  if (typeof tokenId !== "string" || tokenId.trim() === "" || typeof iv !== "string" || typeof ciphertext !== "string") {
    throw new Error("malformed wrappedToken");
  }
  const ivBytes = fromBase64(iv);
  const ctBytes = fromBase64(ciphertext);
  if (ivBytes.length !== 12 || ctBytes.length < 16) {
    throw new Error("invalid wrappedToken iv or ciphertext length");
  }
  const ikmBytes = typeof ikm === "string" ? encoder.encode(ikm) : ikm;
  const keyBytes = await hkdfBits(ikmBytes, info, 256);
  const aesKey = await crypto.subtle.importKey("raw", keyBytes, { name: "AES-GCM" }, false, ["decrypt"]);
  const aad = encoder.encode(wrapAadMessage(profileId, tokenId));
  const plainBuf = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: ivBytes, additionalData: aad, tagLength: 128 },
    aesKey,
    ctBytes,
  );
  const token = decoder.decode(plainBuf).trim().toLowerCase();
  if (!HEX_64_RE.test(token)) {
    throw new Error("unwrapped token is not a valid 32-byte hex secret");
  }
  return { token, tokenId };
}

/** Unwrap the per-browser token minted after bootstrap HMAC authentication. */
export async function unwrapBootstrapToken({ wrappedToken, bootstrapToken, port, extNonce, relayNonce, profileId }) {
  return unwrapBrowserToken({
    wrappedToken,
    ikm: encoder.encode(String(bootstrapToken)),
    info: wrapInfoMessage(port, extNonce, relayNonce),
    profileId,
  });
}

/** Start ephemeral P-256 ECDH state for a one-time code pairing handshake (`pair.hello`). */
export async function startCodePairing() {
  const keyPair = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  );
  const pubRaw = new Uint8Array(await crypto.subtle.exportKey("raw", keyPair.publicKey));
  return {
    keyPair,
    ecdhPub: toBase64(pubRaw),
    extNonce: randomNonceHex(16),
  };
}

/**
 * Compute `pair.response` proof and expected `welcome.proof` from a daemon's `pair.challenge`.
 * Returns `{ extProof, expectedRelayProof, pairKey }`.
 */
export async function buildPairResponse({
  code,
  port,
  extNonce,
  relayNonce,
  extPubB64,
  relayPubB64,
  keyPair,
  salt,
  iterations,
}) {
  const normalized = normalizePairingCode(code);
  if (!normalized) throw new Error("invalid pairing code");
  if (!isValidNonceHex(relayNonce) || !isValidNonceHex(extNonce)) {
    throw new Error("invalid pairing nonce");
  }
  if (typeof salt !== "string" || !HEX_32_RE.test(salt)) {
    throw new Error("invalid pairing salt");
  }
  if (
    typeof iterations !== "number" ||
    !Number.isInteger(iterations) ||
    iterations < PAIR_PBKDF2_MIN_ITERATIONS ||
    iterations > PAIR_PBKDF2_MAX_ITERATIONS
  ) {
    throw new Error("invalid PBKDF2 iteration count");
  }

  const relayPubBytes = fromBase64(relayPubB64);
  if (relayPubBytes.length !== 65 || relayPubBytes[0] !== 0x04) {
    throw new Error("invalid relay ECDH public key");
  }

  const relayPubKey = await crypto.subtle.importKey(
    "raw",
    relayPubBytes,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedBits = await crypto.subtle.deriveBits(
    { name: "ECDH", public: relayPubKey },
    keyPair.privateKey,
    256,
  );
  const sharedSecret = new Uint8Array(sharedBits);

  const pwKey = await crypto.subtle.importKey(
    "raw",
    encoder.encode(normalized),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const codeBits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      salt: fromHex(salt),
      iterations,
    },
    pwKey,
    256,
  );
  const codeKey = new Uint8Array(codeBits);

  const pairKey = await hkdfBits(
    concatBytes(sharedSecret, codeKey),
    pairKeyInfoMessage(port, extNonce.toLowerCase(), relayNonce.toLowerCase(), extPubB64, relayPubB64),
    256,
  );

  const extProof = await hmacHex(
    pairKey,
    pairExtProofMessage(port, relayNonce.toLowerCase(), extNonce.toLowerCase(), extPubB64, relayPubB64),
  );
  const expectedRelayProof = await hmacHex(
    pairKey,
    pairRelayProofMessage(port, extNonce.toLowerCase(), relayNonce.toLowerCase(), extPubB64, relayPubB64),
  );

  return { extProof, expectedRelayProof, pairKey };
}

/**
 * Verify the daemon's mutual code proof in `welcome` before unwrapping the per-browser token.
 */
export async function verifyPairWelcome({
  welcome,
  expectedRelayProof,
  pairKey,
  port,
  extNonce,
  relayNonce,
  profileId,
}) {
  if (!welcome || welcome.type !== "welcome") {
    return { ok: false, error: "expected welcome message" };
  }
  if (!constantTimeEqualHex(expectedRelayProof, welcome.proof)) {
    return { ok: false, error: "invalid relay pairing proof" };
  }
  try {
    const unwrapped = await unwrapBrowserToken({
      wrappedToken: welcome.wrappedToken,
      ikm: pairKey,
      info: pairWrapInfoMessage(port, extNonce.toLowerCase(), relayNonce.toLowerCase()),
      profileId,
    });
    return {
      ok: true,
      token: unwrapped.token,
      tokenId: unwrapped.tokenId,
      slug: typeof welcome.slug === "string" ? welcome.slug : undefined,
    };
  } catch (err) {
    return { ok: false, error: `failed to unwrap browser token: ${err?.message || err}` };
  }
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
