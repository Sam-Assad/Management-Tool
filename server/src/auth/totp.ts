// Authenticator-app codes (TOTP, RFC 6238): the 6-digit codes Microsoft / Google Authenticator show. The phone and
// this server each compute the code from a shared secret and the current time, so neither needs a network.
import crypto from 'node:crypto';

export const PERIOD_S = 30;
const DIGITS = 6;
// codes from one period either side are accepted too, for clocks up to ~30 s apart
const DRIFT_STEPS = 1;

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[^A-Z2-7]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch);
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// 160 random bits, the size RFC 4226 recommends for HMAC-SHA1
export const newSecret = () => base32Encode(crypto.randomBytes(20));

export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / PERIOD_S);

export function codeAt(secret: string, step: number): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const binary = hmac.readUInt32BE(offset) & 0x7fffffff;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

// The time step the code belongs to, or null. A code is only accepted for a step later than `lastUsedStep`,
// so the same code (or an older one) can't be used twice.
export function verifyCode(secret: string, code: string, lastUsedStep: number | null, now = Date.now()): number | null {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return null;
  const step = currentStep(now);
  for (let s = step - DRIFT_STEPS; s <= step + DRIFT_STEPS; s++) {
    if (lastUsedStep !== null && s <= lastUsedStep) continue;
    if (crypto.timingSafeEqual(Buffer.from(codeAt(secret, s)), Buffer.from(typed))) return s;
  }
  return null;
}

// What the authenticator app reads from the QR code.
export function otpauthUri(secret: string, username: string): string {
  const label = encodeURIComponent(`Healthcheck:${username}`);
  return `otpauth://totp/${label}?secret=${secret}&issuer=Healthcheck&algorithm=SHA1&digits=${DIGITS}&period=${PERIOD_S}`;
}
