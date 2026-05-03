export interface SseHandlers {
  onProgress?: (ev: { kind: string; done?: number; total?: number; message?: string; summary?: string }) => void;
  onClosed?: (status: string) => void;
  onError?: (err: Event) => void;
}

export function subscribeSse(url: string, handlers: SseHandlers): () => void {
  const es = new EventSource(url);
  es.addEventListener('progress', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data);
      handlers.onProgress?.(data);
    } catch {
      /* ignore */
    }
  });
  es.addEventListener('closed', (e) => {
    try {
      const data = JSON.parse((e as MessageEvent).data);
      handlers.onClosed?.(data.status);
    } catch {
      handlers.onClosed?.('finished');
    }
    es.close();
  });
  es.onerror = (err) => {
    handlers.onError?.(err);
  };
  return () => es.close();
}
