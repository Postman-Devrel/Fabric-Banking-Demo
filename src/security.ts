const SECRET_FIELD = /(api[-_]?key|authorization|credential|password|secret|token)$/i;

export function sanitize(value: unknown, secrets: string[]): unknown {
  if (typeof value === 'string') {
    let result = value;
    for (const secret of secrets) {
      if (secret.length >= 4) result = result.split(secret).join('[REDACTED]');
    }
    return result;
  }
  if (Array.isArray(value)) return value.map(item => sanitize(item, secrets));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      SECRET_FIELD.test(key) ? '[REDACTED]' : sanitize(item, secrets)
    ]));
  }
  return value;
}

export function findSecretLeaks(value: unknown, secrets: string[]): string[] {
  const serialized = JSON.stringify(value);
  return secrets.filter(secret => secret.length >= 4 && serialized.includes(secret));
}

export function safeError(error: unknown): { code: string; message: string } {
  if (error instanceof DOMException && error.name === 'AbortError') return { code: 'CANCELLED', message: 'The operation was cancelled' };
  if (error instanceof Error) return { code: error.name || 'ERROR', message: error.message };
  return { code: 'ERROR', message: String(error) };
}
