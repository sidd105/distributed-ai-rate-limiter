import { createHmac } from 'node:crypto';

function frame(parts: string[]): string {
  return parts.map((part) => `${Buffer.byteLength(part, 'utf8')}:${part}`).join('|');
}

export class KeyFactory {
  constructor(
    private readonly secret: string,
    private readonly namespace: 'protected' | 'demo' = 'protected',
  ) {}

  private prefix(tenantId: string): string {
    // Preserve existing protected keys; isolate caller-defined demo policies.
    return `rl:v1:{${this.tenantTag(tenantId)}}:${this.namespace === 'demo' ? 'demo:' : ''}`;
  }

  digest(...parts: string[]): string {
    return createHmac('sha256', this.secret).update(frame(parts)).digest('hex');
  }

  tenantTag(tenantId: string): string {
    return `t_${this.digest('tenant', tenantId)}`;
  }

  bucket(tenantId: string, logicalKey: string): string {
    return `${this.prefix(tenantId)}b:${this.digest('bucket', logicalKey)}`;
  }

  operation(tenantId: string, userId: string, idempotencyKey: string): string {
    return `${this.prefix(tenantId)}op:${this.digest('operation', tenantId, userId, idempotencyKey)}`;
  }
}
