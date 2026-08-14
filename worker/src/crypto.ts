import type { AppEnv } from './env';

const encoder = new TextEncoder();

type BinaryData = ArrayBuffer | Uint8Array<ArrayBufferLike>;

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

async function masterKey(env: AppEnv): Promise<CryptoKey> {
  const raw = base64ToBytes(env.MASTER_KEY_B64);
  if (raw.byteLength !== 32) throw new Error('MASTER_KEY_B64 must decode to exactly 32 bytes');
  return crypto.subtle.importKey('raw', raw.buffer, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export type Envelope = {
  ciphertext: ArrayBuffer;
  bodyIv: string;
  encryptedKey: string;
  keyIv: string;
  dataKey: CryptoKey;
};

export async function createEnvelope(data: BinaryData, env: AppEnv): Promise<Envelope> {
  const dataKey = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const rawDataKey = new Uint8Array(await crypto.subtle.exportKey('raw', dataKey));
  const bodyIv = crypto.getRandomValues(new Uint8Array(12));
  const keyIv = crypto.getRandomValues(new Uint8Array(12));
  const kek = await masterKey(env);

  const [ciphertext, wrappedKey] = await Promise.all([
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: bodyIv }, dataKey, toArrayBuffer(data)),
    crypto.subtle.encrypt({ name: 'AES-GCM', iv: keyIv }, kek, rawDataKey.buffer)
  ]);

  return {
    ciphertext,
    bodyIv: bytesToBase64(bodyIv),
    encryptedKey: bytesToBase64(new Uint8Array(wrappedKey)),
    keyIv: bytesToBase64(keyIv),
    dataKey
  };
}

export async function unwrapDataKey(encryptedKey: string, keyIv: string, env: AppEnv): Promise<CryptoKey> {
  const kek = await masterKey(env);
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: base64ToBytes(keyIv) },
    kek,
    base64ToBytes(encryptedKey).buffer
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
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
