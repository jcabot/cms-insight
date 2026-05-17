export type PostType = 'post' | 'page';

export interface AnalysisPlugin {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly version: string;
  readonly storageSchemaVersion: number;
  readonly resultsView: string;
  run(ctx: AnalysisContext): AsyncIterable<ProgressEvent>;
  applyAction?(ctx: ApplyContext, payload: unknown): Promise<ApplyResult>;
  readonly auxiliaryActions?: Record<string, AuxiliaryAction>;
  /**
   * Produce a short headline summary for the home dashboard, e.g. "23 broken / 412 checked".
   * Reads from `storage` (post-run state on disk). Optional — host falls back to the
   * `finished` event's `summary` string when omitted.
   */
  formatHeadline?(storage: PluginStorage): Promise<string | undefined>;
}

export interface AuxiliaryAction {
  readonly id: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema?: object;
  /** Whether the action requires `ctx.llm` to be configured. Host returns 503 when true and llm is missing. */
  readonly requiresLlm?: boolean;
  run(ctx: AnalysisContext, payload: unknown): AsyncIterable<ProgressEvent>;
}

export interface AnalysisContext {
  readonly contentDir: string;
  readonly siteUrl: string;
  readonly posts: AsyncIterable<ParsedPost>;
  readonly storage: PluginStorage;
  readonly signal: AbortSignal;
  readonly config: unknown;
  readonly llm?: LlmProvider;
}

export interface PluginStorage {
  readonly rootDir: string;
  read<T = unknown>(key: string): Promise<T | undefined>;
  write(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix?: string): AsyncIterable<string>;
}

export interface ApplyContext {
  readonly contentDir: string;
  readonly storage: PluginStorage;
  readFile(relativePath: string): Promise<Buffer>;
  writeFile(relativePath: string, contents: Buffer, expectedHash: string): Promise<void>;
}

export interface ParsedPost {
  readonly id: number | undefined;
  readonly type: PostType;
  readonly slug: string;
  readonly title: string;
  readonly status: string;
  readonly filePath: string;
  readonly bodyHash: string;
  body(): Promise<string>;
}

export type ProgressEvent =
  | { kind: 'started'; total?: number }
  | { kind: 'progress'; done: number; total?: number; message?: string }
  | { kind: 'warn'; message: string }
  | { kind: 'finished'; summary: string };

export interface ApplyResult {
  ok: boolean;
  message?: string;
  changedFiles?: readonly string[];
}

export interface PluginManifest {
  readonly id: string;
  readonly version: string;
  readonly apiVersion: string;
}

/* ─── LLM abstraction ─────────────────────────────────── */

export interface LlmImageInput {
  /** Image media type. Anthropic vision supports jpeg/png/gif/webp. */
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  /** Base64-encoded image bytes (no data URI prefix). */
  dataBase64: string;
}

export interface LlmCompleteRequest {
  systemPrompt: string;
  userMessage: string;
  /** Provider-dependent hint to cache the system prompt across calls (e.g. Anthropic ephemeral cache). */
  cacheSystemPrompt?: boolean;
  maxTokens?: number;
  /** When set, the response is parsed into `json` using this JSON Schema. */
  responseSchema?: object;
  /** Optional images delivered to a vision-capable model alongside `userMessage`. */
  images?: ReadonlyArray<LlmImageInput>;
  signal?: AbortSignal;
}

export interface LlmCompleteResponse {
  text: string;
  json?: unknown;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cached_input_tokens?: number;
  };
}

export interface LlmProvider {
  readonly name: string;
  readonly model: string;
  complete(req: LlmCompleteRequest): Promise<LlmCompleteResponse>;
}
