import crypto from 'node:crypto';
import { promisify } from 'node:util';

// ---- hashing ------------------------------------------------------------------------------------------
// scrypt (memory-hard, built into Node - no native add-on to install) with a fresh random salt per password.
// Stored as "scrypt$N$r$p$salt$hash" so the cost can be raised later without breaking existing hashes.
const scrypt = promisify(crypto.scrypt) as (pw: string | Buffer, salt: Buffer, keylen: number, opts: crypto.ScryptOptions) => Promise<Buffer>;
const N = 2 ** 15;
const R = 8;
const P = 1;
const KEYLEN = 64;
const MAXMEM = 128 * N * R * 2;

// The same text however it was typed (e.g. composed vs decomposed accents) hashes the same.
const normalize = (pw: string) => pw.normalize('NFKC');

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.randomBytes(16);
  const hash = await scrypt(normalize(password), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
  if (scheme !== 'scrypt' || !hashB64) return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scrypt(normalize(password), Buffer.from(saltB64, 'base64'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 128 * Number(n) * Number(r) * 2,
  });
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

// Checked against when the username doesn't exist, so a wrong username takes as long as a wrong password
// (otherwise the response time would tell which usernames are real).
let dummyHash: Promise<string> | null = null;
export async function burnTime(password: string) {
  dummyHash ??= hashPassword(crypto.randomBytes(12).toString('hex'));
  await verifyPassword(password, await dummyHash);
}

// ---- policy (NIST SP 800-63B) --------------------------------------------------------------------------
// Length over complexity: at least 12 characters, any characters (spaces and non-Latin letters included), no
// "must contain a symbol" rules and no forced periodic changes. Refused: common/breached-style passwords, the
// username or the product's own words, and trivial patterns.
export const MIN_LENGTH = 12;
export const MAX_LENGTH = 128;

const COMMON = new Set(
  [
    'password', 'password1', 'password12', 'password123', 'password1234', 'passw0rd', 'p@ssw0rd', 'p@ssword',
    'qwerty', 'qwerty123', 'qwertyuiop', 'qwerty123456', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1q2w3e4r5t',
    '1qaz2wsx', '1qaz2wsx3edc', 'zaq12wsx', 'iloveyou', 'welcome', 'welcome1', 'welcome123', 'letmein',
    'letmein123', 'admin', 'admin123', 'admin1234', 'administrator', 'root', 'toor', 'changeme', 'changeme123',
    'default', 'secret', 'secret123', 'monkey', 'dragon', 'football', 'baseball', 'superman', 'batman',
    'trustno1', 'sunshine', 'princess', 'starwars', 'whatever', 'master', 'login', 'abc123', 'abcd1234',
    '123456', '1234567', '12345678', '123456789', '1234567890', '12345678910', '123123123', '111111111111',
    '000000000000', '123456123456', '987654321', '0987654321', '147258369', 'aa123456', 'abc123456',
    'healthcheck', 'healthcheck1', 'healthcheck123', 'vodafone', 'vodafone1', 'vodafone123', 'loyalty',
    'loyalty123', 'wildfly', 'artemis', 'keycloak', 'summer2024', 'summer2025', 'summer2026', 'winter2025',
    'winter2026', 'spring2026', 'autumn2026',
  ],
);
// words that make a password guessable here, wherever they appear in it
const LOCAL_WORDS = ['healthcheck', 'vodafone', 'loyalty', 'password', 'qwerty', 'admin'];

const isSequence = (s: string) => {
  if (s.length < 4) return false;
  const step = s.charCodeAt(1) - s.charCodeAt(0);
  if (Math.abs(step) !== 1) return false;
  for (let i = 2; i < s.length; i++) if (s.charCodeAt(i) - s.charCodeAt(i - 1) !== step) return false;
  return true;
};

// Plain-language reasons the password can't be used (empty = fine).
export function passwordProblems(password: string, username: string, displayName?: string): string[] {
  const problems: string[] = [];
  const pw = normalize(password);
  const lower = pw.toLowerCase();
  // count characters, not UTF-16 code units, so emoji/accents count as one each
  const length = [...pw].length;
  if (length < MIN_LENGTH) problems.push(`Use at least ${MIN_LENGTH} characters (this has ${length}).`);
  if (length > MAX_LENGTH) problems.push(`Use at most ${MAX_LENGTH} characters.`);
  const compact = lower.replace(/[\s\W_]+/g, '');
  if (COMMON.has(lower) || COMMON.has(compact) || COMMON.has(compact.replace(/\d+$/, ''))) {
    problems.push('This is a very common password. Choose something less predictable.');
  } else if (LOCAL_WORDS.some((w) => compact.includes(w)) && compact.replace(new RegExp(LOCAL_WORDS.join('|'), 'g'), '').length < 6) {
    problems.push('Too close to a well-known word (like "password", "admin", "vodafone" or "healthcheck"). Add more of your own.');
  }
  const u = username.trim().toLowerCase();
  if (u.length >= 3 && lower.includes(u)) problems.push("Don't include your username.");
  const d = (displayName ?? '').trim().toLowerCase();
  if (d.length >= 4 && d !== u && lower.includes(d)) problems.push("Don't include your name.");
  if (length >= MIN_LENGTH && new Set([...lower]).size <= 2) problems.push('Too repetitive. Use a mix of different characters or words.');
  else if (length >= MIN_LENGTH && isSequence(compact)) problems.push('A simple sequence like "abcdef" or "123456" is easy to guess.');
  return problems;
}

// ---- temporary passwords (new account / admin reset) ----------------------------------------------------
// 16 characters from an alphabet without look-alikes (no 0/O, 1/l/I), ~93 bits, grouped for reading aloud.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function temporaryPassword(): string {
  const chars = Array.from({ length: 16 }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]);
  return [0, 4, 8, 12].map((i) => chars.slice(i, i + 4).join('')).join('-');
}
