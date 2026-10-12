import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

export const MINUTE = 60_000;

export class AppError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function hashSecret(secret) {
  const salt = randomBytes(16);
  const hash = scryptSync(String(secret), salt, 32);
  return `${salt.toString('hex')}:${hash.toString('hex')}`;
}

export function verifySecret(secret, stored) {
  const [saltHex, hashHex] = String(stored).split(':');
  if (!saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = scryptSync(String(secret), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(expected, actual);
}

export const randomToken = (bytes = 24) => randomBytes(bytes).toString('base64url');

// Billing is per started minute, rounded up to the whole currency unit.
export function billableMinutes(ms) {
  return Math.max(1, Math.ceil(ms / MINUTE));
}

export function costFor(minutes, hourlyRate) {
  return Math.ceil((minutes * hourlyRate) / 60);
}

export function affordableMinutes(balance, hourlyRate) {
  if (hourlyRate <= 0) return Infinity;
  return Math.floor((balance * 60) / hourlyRate);
}

export function usedMs(session, at) {
  const end = session.ended_at ?? at;
  const openPause = session.paused_at != null ? end - session.paused_at : 0;
  return Math.max(0, end - session.started_at - session.paused_total - openPause);
}

// Validation helpers: throw a 400 with a readable message.
export function requireText(value, field, { max = 80 } = {}) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new AppError(400, `${field} is required`);
  if (text.length > max) throw new AppError(400, `${field} is too long`);
  return text;
}

export function requireInt(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw new AppError(400, `${field} must be a whole number between ${min} and ${max}`);
  }
  return n;
}

export function requireOneOf(value, field, options) {
  if (!options.includes(value)) throw new AppError(400, `${field} must be one of: ${options.join(', ')}`);
  return value;
}
