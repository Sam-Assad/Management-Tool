// An independent TOTP (RFC 6238) - what a phone app computes - so the tests don't check the app against itself.
import crypto from 'node:crypto';

export function b32decode(s: string): Buffer {
  const A = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  const bits = [...s.replace(/[\s=]/g, '').toUpperCase()].map((c) => A.indexOf(c).toString(2).padStart(5, '0')).join('');
  const bytes: number[] = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

export function phoneCode(secretB32: string, at = Date.now(), digits = 6): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)));
  const h = crypto.createHmac('sha1', b32decode(secretB32)).update(counter).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 10 ** digits).padStart(digits, '0');
}

// set up the authenticator for a signed-in admin, as a person would: start, scan, type the code
export async function enroll(b: { call: (m: string, p: string, body?: unknown) => Promise<{ status: number; json: any }> }, password?: string) {
  const s = await b.call('POST', '/auth/authenticator/start');
  const c = await b.call('POST', '/auth/authenticator/confirm', { code: phoneCode(s.json.secret), password });
  if (c.status !== 200) throw new Error(`enroll failed: ${JSON.stringify(c)}`);
  return s.json.secret as string;
}
