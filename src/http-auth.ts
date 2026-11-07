/** Credentials must be proven by an unexpired server-issued bearer token. */
export function authenticateBearer(
  authorization: string | undefined,
  tokens: Record<string, { username: string; password?: string; expiresAt: number }>,
  now = Date.now(),
): { username: string; password?: string } | null {
  if (!authorization?.startsWith("Bearer ")) return null;
  const record = tokens[authorization.slice(7).trim()];
  if (!record || record.expiresAt <= now) return null;
  return { username: record.username, password: record.password };
}
