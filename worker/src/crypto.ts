import type { AppEnv } from './env';

const encoder = new TextEncoder();

type BinaryData = ArrayBuffer | Uint8Array<ArrayBufferLike>;
export type KeySlot = 'A' | 'B';
export type KeyRotationState = {
  activeSlot: KeySlot;
  activeVersion: number;
  targetSlot: KeySlot | null;
  targetVersion: number | null;
  phase: 'stable' | 'rewrapping';
};

type RotationStateRow = {
  active_slot: KeySlot;
  active_version: number;
  target_slot: KeySlot | null;
  target_version: number | null;
  phase: 'stable' | 'rewrapping';
};

let rotationStateCache: { value: KeyRotationState; expiresAt: number } | null = null;

function toArrayBuffer(value: BinaryData): ArrayBuffer {
  if (value instanceof ArrayBuffer) return value;
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

export function bytesToBase64(bytes: Uint8Array<ArrayBufferLike>): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array<ArrayBuffer> {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
  const binary = atob(padded);
  const out: Uint8Array<ArrayBuffer> = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

export function randomToken(byteLength = 32): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return bytesToBase64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export async function sha256Hex(value: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value).buffer));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function constantTimeEqual(
  a: Uint8Array<ArrayBufferLike>,
  b: Uint8Array<ArrayBufferLike>
): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a[i] ^ b[i];
  return diff === 0;
}

function secretForSlot(env: AppEnv, slot: KeySlot): string {
  const value = slot === 'A' ? env.MASTER_KEY_B64 : env.MASTER_KEY_SLOT_B_B64;
  if (!value) throw new Error(`Master key slot ${slot} is not configured`);
  return value;
}

async function importKek(secret: string, slot: KeySlot): Promise<CryptoKey> {
  const raw = base64ToBytes(secret);
  if (raw.byteLength !== 32) throw new Error(`Master key slot ${slot} must decode to exactly 32 bytes`);
  return crypto.subtle.importKey('raw', raw.buffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export function invalidateKeyRotationStateCache(): void {
  rotationStateCache = null;
}

export async function getKeyRotationState(env: AppEnv, force = false): Promise<KeyRotationState> {
  const now = Date.now();
  if (!force && rotationStateCache && rotationStateCache.expiresAt > now) return rotationStateCache.value;

  const row = await env.DB.prepare(
    `SELECT active_slot, active_version, target_slot, target_version, phase
     FROM key_rotation_state WHERE id = 1 LIMIT 1`
  ).first<RotationStateRow>();

  const value: KeyRotationState = row ? {
    activeSlot: row.active_slot,
    activeVersion: Number(row.active_version),
    targetSlot: row.target_slot,
    targetVersion: row.target_version === null ? null : Number(row.target_version),
    phase: row.phase
  } : {
    activeSlot: 'A',
    activeVersion: 1,
    targetSlot: null,
    targetVersion: null,
    phase: 'stable'
  };

  rotationStateCache = { value, expiresAt: now + 5_000 };
  return value;
}

function parseVersionedEncryptedKey(value: string): { version: number; ciphertext: string } {
  const match = value.match(/^v(\d+):(.+)$/s);
  if (!match) return { version: 1, ciphertext: value };
  const version = Number(match[1]);
  if (!Number.isSafeInteger(version) || version < 1) throw new Error('Invalid encrypted data key version');
  return { version, ciphertext: match[2] };
}

export function encryptedKeyVersion(value: string): number {
  return parseVersionedEncryptedKey(value).version;
}

function encodeVersionedEncryptedKey(version: number, ciphertext: string): string {
  return `v${version}:${ciphertext}`;
}

async function keyForVersion(env: AppEnv, version: number, state?: KeyRotationState): Promise<CryptoKey> {
  const current = state || await getKeyRotationState(env);
  if (version === current.activeVersion) {
    return importKek(secretForSlot(env, current.activeSlot), current.activeSlot);
  }
  if (
    current.phase === 'rewrapping' &&
    current.targetSlot &&
    current.targetVersion !== null &&
    version === current.targetVersion
  ) {
    return importKek(secretForSlot(env, current.targetSlot), current.targetSlot);
  }
  throw new Error(`No master key is available for encrypted data key version ${version}`);
}

async function writeKey(env: AppEnv): Promise<{ key: CryptoKey; version: number }> {
  const state = await getKeyRotationState(env, true);
  if (state.phase === 'rewrapping' && state.targetSlot && state.targetVersion !== null) {
    return {
      key: await importKek(secretForSlot(env, state.targetSlot), state.targetSlot),
      version: state.targetVersion
    };
  }
  return {
    key: await importKek(secretForSlot(env, state.activeSlot), state.activeSlot),
    version: state.activeVersion
  };
}

export type Envelope = {
  ciphertext: ArrayBuffer;
  bodyIv: string;
  encryptedKey: string;
  keyIv: string;
  dataKey: CryptoKey;
  keyVersion: number;
};

export async function createEnvelope(data: BinaryData, env: AppEnv): Promise<Envelope> {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
  const bodyIv = crypto.getRandomValues(new Uint8Array(12));
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const write = await writeKey(env);

  const [ciphertext, wrappedKey] = await Promise.all([
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: bodyIv }, dataKey, toArrayBuffer(data)),
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, write.key, rawDataKey.buffer)
  ]);

  return {
    ciphertext,
    bodyIv: bytesToBase64(bodyIv),
    encryptedKey: encodeVersionedEncryptedKey(write.version, bytesToBase64(new Uint8Array(wrappedKey))),
    keyIv: bytesToBase64(keyIv),
    dataKey,
    keyVersion: write.version
  };
}

export async function unwrapDataKey(encryptedKey: string, keyIv: string, env: AppEnv): Promise<CryptoKey> {
  const parsed = parseVersionedEncryptedKey(encryptedKey);
  const state = await getKeyRotationState(env);
  const kek = await keyForVersion(env, parsed.version, state);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(keyIv) },
    kek,
    base64ToBytes(parsed.ciphertext).buffer
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function rewrapEncryptedDataKey(
  encryptedKey: string,
  keyIv: string,
  env: AppEnv
): Promise<{ encryptedKey: string; keyIv: string; fromVersion: number; toVersion: number }> {
  const state = await getKeyRotationState(env, true);
  if (state.phase !== 'rewrapping' || !state.targetSlot || state.targetVersion === null) {
    throw new Error('No key rotation is currently active');
  }

  const parsed = parseVersionedEncryptedKey(encryptedKey);
  if (parsed.version === state.targetVersion) {
    return { encryptedKey, keyIv, fromVersion: parsed.version, toVersion: state.targetVersion };
  }
  if (parsed.version !== state.activeVersion) {
    throw new Error(`Unexpected encrypted data key version ${parsed.version} during rotation`);
  }

  const source = await importKek(secretForSlot(env, state.activeSlot), state.activeSlot);
  const target = await importKek(secretForSlot(env, state.targetSlot), state.targetSlot);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(keyIv) },
    source,
    base64ToBytes(parsed.ciphertext).buffer
  );
  const nextIv = crypto.getRandomValues(new Uint8Array(12));
  const wrapped = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nextIv }, target, raw);

  return {
    encryptedKey: encodeVersionedEncryptedKey(state.targetVersion, bytesToBase64(new Uint8Array(wrapped))),
    keyIv: bytesToBase64(nextIv),
    fromVersion: parsed.version,
    toVersion: state.targetVersion
  };
}

export async function encryptWithDataKey(
  data: BinaryData,
  dataKey: CryptoKey
): Promise<{ ciphertext: ArrayBuffer; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, toArrayBuffer(data));
  return { ciphertext, iv: bytesToBase64(iv) };
}

export async function decryptWithDataKey(
  ciphertext: BinaryData,
  iv: string,
  dataKey: CryptoKey
): Promise<ArrayBuffer> {
  return crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(iv) },
    dataKey,
    toArrayBuffer(ciphertext)
  );
}
