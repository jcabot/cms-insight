export const DEFAULT_CONFIG_TOML = `port              = 5174
open_browser      = true
post_statuses     = ["publish"]
external_only     = true
concurrency_global = 20
concurrency_per_host = 2
per_host_min_delay_ms = 250
ttl_ok_days       = 30
ttl_suspicious_days = 7
ttl_broken_days   = 1
strip_tracking_params = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "fbclid", "gclid"]
editor_command    = ""

[llm]
provider              = "anthropic"
model                 = "claude-haiku-4-5"
suggest_batch_size    = 20
suggest_concurrency   = 3
suggest_context_chars = 200
`;

export interface LlmConfigSection {
  provider: 'anthropic';
  model: string;
  suggest_batch_size: number;
  suggest_concurrency: number;
  suggest_context_chars: number;
}

export interface CmsInsightConfig {
  port: number;
  open_browser: boolean;
  post_statuses: string[];
  external_only: boolean;
  concurrency_global: number;
  concurrency_per_host: number;
  per_host_min_delay_ms: number;
  ttl_ok_days: number;
  ttl_suspicious_days: number;
  ttl_broken_days: number;
  strip_tracking_params: string[];
  editor_command: string;
  llm: LlmConfigSection;
}

export const LLM_DEFAULTS: LlmConfigSection = {
  provider: 'anthropic',
  model: 'claude-haiku-4-5',
  suggest_batch_size: 20,
  suggest_concurrency: 3,
  suggest_context_chars: 200,
};

export const CONFIG_DEFAULTS: CmsInsightConfig = {
  port: 5174,
  open_browser: true,
  post_statuses: ['publish'],
  external_only: true,
  concurrency_global: 20,
  concurrency_per_host: 2,
  per_host_min_delay_ms: 250,
  ttl_ok_days: 30,
  ttl_suspicious_days: 7,
  ttl_broken_days: 1,
  strip_tracking_params: [
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'utm_term',
    'utm_content',
    'fbclid',
    'gclid',
  ],
  editor_command: '',
  llm: LLM_DEFAULTS,
};
