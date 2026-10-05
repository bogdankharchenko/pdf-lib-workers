import type { Env } from "./env";

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
  return btoa(String.fromCharCode(...sig)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function signingKey(env: Env): string | undefined {
  return env.SIGNING_KEY || env.API_KEY;
}

export function encodeKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

/** Builds a time-limited link that downloads `key` without the API key. */
export async function signedUrl(env: Env, origin: string, key: string, ttlSeconds?: number): Promise<{ url: string; expiresAt: string }> {
  const secret = signingKey(env);
  const ttl = ttlSeconds ?? Number(env.SIGNED_URL_TTL || 3600);
  const expires = Math.floor(Date.now() / 1000) + ttl;
  const url = new URL(`/files/${encodeKey(key)}`, origin);
  if (secret) {
    url.searchParams.set("expires", String(expires));
    url.searchParams.set("sig", await hmac(secret, `${key}\n${expires}`));
  }
  return { url: url.toString(), expiresAt: new Date(expires * 1000).toISOString() };
}

export async function verifySignature(env: Env, key: string, expires: string | undefined, sig: string | undefined): Promise<boolean> {
  const secret = signingKey(env);
  if (!secret || !expires || !sig) return false;
  const exp = Number(expires);
  if (!Number.isFinite(exp) || exp < Date.now() / 1000) return false;
  const expected = await hmac(secret, `${key}\n${exp}`);
  return timingSafeEqual(expected, sig);
}

export function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  return crypto.subtle.timingSafeEqual(ab, bb);
}
