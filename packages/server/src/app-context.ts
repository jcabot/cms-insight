import type { CmsInsightConfig } from './config/defaults.js';
import type { PluginRunner } from './plugins/runner.js';

export interface AppContext {
  contentDir: string;
  siteUrl: string;
  config: CmsInsightConfig;
  runner: PluginRunner;
  /** Set when the LLM provider could not be constructed (e.g. missing API key). */
  llmDisabledReason: string | undefined;
  /** Validate `newDir`, swap the runner over to it, and update fields in place. Throws on bad path. */
  reload(newDir: string): Promise<void>;
}
