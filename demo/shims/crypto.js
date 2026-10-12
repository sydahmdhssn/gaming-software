// Browser stand-in for node:crypto, used only by the demo build.
// The hash is NOT secure; it only lets the demo check demo PINs and passwords.
class Bytes {
  constructor(hex, raw = null) {
    this.hex = hex;
    this.raw = raw;
    this.length = hex.length / 2;
  }
  toString(encoding = 'hex') {
    if (encoding === 'base64url' && this.raw) {
      return btoa(String.fromCharCode(...this.raw)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    }
    return this.hex;
  }
}

export function randomBytes(n) {
  const raw = crypto.getRandomValues(new Uint8Array(n));
  return new Bytes([...raw].map((b) => b.toString(16).padStart(2, '0')).join(''), raw);
}

export function scryptSync(secret, salt, length) {
  const input = `${secret}:${salt.toString('hex')}`;
  let out = '';
  let h = 2166136261;
  for (let round = 0; out.length < length * 2; round++) {
    for (const ch of input + round) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 16777619) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return new Bytes(out.slice(0, length * 2));
}

export function timingSafeEqual(a, b) {
  return a.toString('hex') === b.toString('hex');
}

globalThis.Buffer ??= { from: (value) => new Bytes(String(value)) };
