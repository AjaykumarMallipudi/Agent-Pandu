import { useEffect, useState } from 'react';
import { withToken } from './api';

/** Subscribes to an SSE endpoint emitting `snapshot` events; reconnects automatically (EventSource default). */
export function useSnapshotStream<T>(url: string | null): { data: T | null; connected: boolean } {
  const [data, setData] = useState<T | null>(null);
  const [connected, setConnected] = useState(false);
  useEffect(() => {
    if (!url) return;
    const es = new EventSource(withToken(url));
    es.addEventListener('snapshot', (e) => {
      setConnected(true);
      setData(JSON.parse((e as MessageEvent<string>).data) as T);
    });
    es.onerror = () => setConnected(false);
    return () => es.close();
  }, [url]);
  return { data, connected };
}
