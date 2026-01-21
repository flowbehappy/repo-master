const DEFAULT_TTL_MS = 10 * 60 * 1000;

const seen = new Map<string, number>();

function prune(now: number) {
  for (const [key, expiresAt] of seen.entries()) {
    if (expiresAt <= now) seen.delete(key);
  }
}

export function markIfNew(key: string, ttlMs: number = DEFAULT_TTL_MS): boolean {
  const now = Date.now();
  prune(now);

  const existing = seen.get(key);
  if (existing && existing > now) return false;

  seen.set(key, now + ttlMs);
  return true;
}

