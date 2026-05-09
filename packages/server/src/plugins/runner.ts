import type {
  AnalysisContext,
  AnalysisPlugin,
  AuxiliaryAction,
  LlmProvider,
  ParsedPost,
  PluginStorage,
  ProgressEvent,
} from '@cms-insight/plugin-api';
import type { CmsInsightConfig } from '../config/defaults.js';
import { scanPosts } from '../content/scan.js';
import { discoverPlugins, type RegisteredPlugin } from './registry.js';

export interface RunOptions {
  fullRecheck?: boolean;
  reExtractAll?: boolean;
}

export type RunStatus = 'running' | 'finished' | 'cancelled' | 'error';

export const PRIMARY_ACTION = 'primary';

export interface RunState {
  pluginId: string;
  actionName: string;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  events: ProgressEvent[];
  options: unknown;
  errorMessage?: string;
}

type Subscriber = (event: ProgressEvent | { kind: 'closed'; status: RunStatus }) => void;

const MAX_EVENT_HISTORY = 200;

interface InternalRun {
  state: RunState;
  controller: AbortController;
  subscribers: Set<Subscriber>;
}

function pushEvent(state: RunState, ev: ProgressEvent): void {
  state.events.push(ev);
  if (state.events.length > MAX_EVENT_HISTORY) {
    state.events.splice(0, state.events.length - MAX_EVENT_HISTORY);
  }
}

function jobKey(pluginId: string, actionName: string): string {
  return `${pluginId}::${actionName}`;
}

export interface CreatePluginRunnerOptions {
  contentDir: string;
  siteUrl: string;
  config: CmsInsightConfig;
  llm?: LlmProvider;
  /** Called whenever a job (run or auxiliary action) reaches a terminal status. */
  onJobFinished?: (info: {
    pluginId: string;
    actionName: string;
    status: RunStatus;
    finishedAt: string;
    /** The summary string from the plugin's `finished` event, if any. */
    summary?: string;
    plugin: AnalysisPlugin;
    storage: PluginStorage;
  }) => void;
}

export interface AuxiliaryActionInfo {
  id: string;
  displayName: string;
  description: string;
  requiresLlm: boolean;
  inputSchema?: object;
  state?: RunState;
}

export interface PluginRunner {
  list(): RegisteredPlugin[];
  get(id: string): RegisteredPlugin | undefined;

  /** Start the plugin's primary `run()` flow. */
  startRun(id: string, options: RunOptions): Promise<RunState>;
  cancelRun(id: string): boolean;
  getRun(id: string): RunState | undefined;
  subscribe(id: string, cb: Subscriber): () => void;

  /** Auxiliary actions declared by the plugin. */
  listActions(pluginId: string): AuxiliaryActionInfo[];
  startAction(pluginId: string, actionName: string, payload: unknown): Promise<RunState>;
  cancelAction(pluginId: string, actionName: string): boolean;
  getAction(pluginId: string, actionName: string): RunState | undefined;
  subscribeAction(pluginId: string, actionName: string, cb: Subscriber): () => void;

  /** True when the host's LLM provider is configured. */
  readonly llmEnabled: boolean;

  contentDir: string;
  siteUrl: string;
  config: CmsInsightConfig;
}

export async function createPluginRunner(
  opts: CreatePluginRunnerOptions,
): Promise<PluginRunner> {
  const plugins = await discoverPlugins({ contentDir: opts.contentDir });
  const byId = new Map<string, RegisteredPlugin>();
  for (const p of plugins) byId.set(p.plugin.id, p);

  const jobs = new Map<string, InternalRun>();

  function buildContext(
    reg: RegisteredPlugin,
    signal: AbortSignal,
    runtimeConfig: unknown,
  ): AnalysisContext {
    return {
      contentDir: opts.contentDir,
      siteUrl: opts.siteUrl,
      posts: scanPostsForPlugin(opts.contentDir, opts.config.post_statuses),
      storage: reg.storage,
      signal,
      config: runtimeConfig,
      llm: opts.llm,
    };
  }

  async function startJob(
    pluginId: string,
    actionName: string,
    options: unknown,
    runner: (ctx: AnalysisContext) => AsyncIterable<ProgressEvent>,
  ): Promise<RunState> {
    const reg = byId.get(pluginId);
    if (!reg) throw new Error(`unknown plugin: ${pluginId}`);
    const key = jobKey(pluginId, actionName);
    const existing = jobs.get(key);
    if (existing && existing.state.status === 'running') {
      throw new Error(`${pluginId}/${actionName} is already running`);
    }
    const ac = new AbortController();
    const state: RunState = {
      pluginId,
      actionName,
      status: 'running',
      startedAt: new Date().toISOString(),
      events: [],
      options,
    };
    const internal: InternalRun = {
      state,
      controller: ac,
      subscribers: new Set(),
    };
    jobs.set(key, internal);

    const ctx = buildContext(reg, ac.signal, options);
    void execute(runner, ctx, internal, reg.plugin, reg.storage, opts.onJobFinished);
    return state;
  }

  function cancel(pluginId: string, actionName: string): boolean {
    const r = jobs.get(jobKey(pluginId, actionName));
    if (!r || r.state.status !== 'running') return false;
    r.controller.abort();
    return true;
  }

  function subscribeJob(pluginId: string, actionName: string, cb: Subscriber): () => void {
    const r = jobs.get(jobKey(pluginId, actionName));
    if (!r) {
      cb({ kind: 'closed', status: 'finished' });
      return () => {};
    }
    for (const ev of r.state.events) cb(ev);
    if (r.state.status !== 'running') {
      cb({ kind: 'closed', status: r.state.status });
      return () => {};
    }
    r.subscribers.add(cb);
    return () => r.subscribers.delete(cb);
  }

  return {
    contentDir: opts.contentDir,
    siteUrl: opts.siteUrl,
    config: opts.config,
    llmEnabled: !!opts.llm,
    list: () => plugins,
    get: (id: string) => byId.get(id),

    startRun(id, options) {
      const reg = byId.get(id);
      if (!reg) throw new Error(`unknown plugin: ${id}`);
      return startJob(id, PRIMARY_ACTION, { ...opts.config, runOptions: options }, (ctx) =>
        reg.plugin.run(ctx),
      );
    },
    cancelRun: (id) => cancel(id, PRIMARY_ACTION),
    getRun: (id) => jobs.get(jobKey(id, PRIMARY_ACTION))?.state,
    subscribe: (id, cb) => subscribeJob(id, PRIMARY_ACTION, cb),

    listActions(pluginId) {
      const reg = byId.get(pluginId);
      if (!reg) return [];
      const actions = reg.plugin.auxiliaryActions ?? {};
      return Object.values(actions).map((a) => ({
        id: a.id,
        displayName: a.displayName,
        description: a.description,
        requiresLlm: !!a.requiresLlm,
        inputSchema: a.inputSchema,
        state: jobs.get(jobKey(pluginId, a.id))?.state,
      }));
    },
    startAction(pluginId, actionName, payload) {
      const reg = byId.get(pluginId);
      if (!reg) throw new Error(`unknown plugin: ${pluginId}`);
      const action: AuxiliaryAction | undefined = reg.plugin.auxiliaryActions?.[actionName];
      if (!action) throw new Error(`unknown action: ${pluginId}/${actionName}`);
      if (action.requiresLlm && !opts.llm) {
        throw new Error(`action ${actionName} requires an LLM provider; set ANTHROPIC_API_KEY`);
      }
      return startJob(pluginId, actionName, payload, (ctx) => action.run(ctx, payload));
    },
    cancelAction: (pluginId, actionName) => cancel(pluginId, actionName),
    getAction: (pluginId, actionName) => jobs.get(jobKey(pluginId, actionName))?.state,
    subscribeAction: (pluginId, actionName, cb) => subscribeJob(pluginId, actionName, cb),
  };
}

async function* scanPostsForPlugin(
  contentDir: string,
  statuses: ReadonlyArray<string>,
): AsyncIterable<ParsedPost> {
  for await (const p of scanPosts(contentDir, { statuses })) {
    yield p;
  }
}

async function execute(
  runner: (ctx: AnalysisContext) => AsyncIterable<ProgressEvent>,
  ctx: AnalysisContext,
  internal: InternalRun,
  plugin: AnalysisPlugin,
  storage: PluginStorage,
  onJobFinished: CreatePluginRunnerOptions['onJobFinished'],
): Promise<void> {
  const GRACE_MS = 5000;
  let graceTimer: NodeJS.Timeout | undefined;
  const onAbort = (): void => {
    graceTimer = setTimeout(() => {
      // The plugin must observe ctx.signal — we can't forcibly kill the iterator.
    }, GRACE_MS);
  };
  internal.controller.signal.addEventListener('abort', onAbort);

  let lastFinishedSummary: string | undefined;
  try {
    for await (const ev of runner(ctx)) {
      pushEvent(internal.state, ev);
      if (ev.kind === 'finished') lastFinishedSummary = ev.summary;
      for (const sub of internal.subscribers) sub(ev);
      if (internal.controller.signal.aborted) {
        internal.state.status = 'cancelled';
        break;
      }
    }
    if (internal.state.status === 'running') {
      internal.state.status = 'finished';
    }
  } catch (err) {
    internal.state.status = 'error';
    internal.state.errorMessage = (err as Error).message;
    pushEvent(internal.state, { kind: 'warn', message: (err as Error).message });
    for (const sub of internal.subscribers) {
      sub({ kind: 'warn', message: (err as Error).message });
    }
  } finally {
    if (graceTimer) clearTimeout(graceTimer);
    internal.controller.signal.removeEventListener('abort', onAbort);
    const finishedAt = new Date().toISOString();
    internal.state.finishedAt = finishedAt;
    for (const sub of internal.subscribers) {
      sub({ kind: 'closed', status: internal.state.status });
    }
    internal.subscribers.clear();
    if (onJobFinished) {
      try {
        onJobFinished({
          pluginId: internal.state.pluginId,
          actionName: internal.state.actionName,
          status: internal.state.status,
          finishedAt,
          summary: lastFinishedSummary,
          plugin,
          storage,
        });
      } catch (err) {
        // Don't let registry callback errors propagate into the runner.
        console.warn(`[cms-insight] onJobFinished failed: ${(err as Error).message}`);
      }
    }
  }
}
