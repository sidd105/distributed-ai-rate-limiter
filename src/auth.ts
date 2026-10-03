import { timingSafeEqual } from 'node:crypto';

export interface AuthContext {
  tenantId: string;
  userId: string;
}

export function authenticate(
  header: string | undefined,
  expectedToken: string,
): AuthContext | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  const supplied = Buffer.from(header.slice(7));
  const expected = Buffer.from(expectedToken);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return undefined;
  return { tenantId: 'merchant-demo', userId: 'support-agent-demo' };
}
