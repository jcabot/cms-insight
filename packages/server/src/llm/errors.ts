export class LlmError extends Error {
  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'LlmError';
  }
}

export class RateLimitError extends LlmError {
  constructor(message: string, readonly retryAfterMs?: number, cause?: unknown) {
    super(message, cause);
    this.name = 'RateLimitError';
  }
}

export class TransientLlmError extends LlmError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = 'TransientLlmError';
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof RateLimitError || err instanceof TransientLlmError;
}
