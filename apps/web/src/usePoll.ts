import { useCallback, useEffect, useRef, useState } from "react";

export interface Polled<T> {
  data: T | undefined;
  error: unknown;
  loading: boolean;
  reload: () => Promise<void>;
}

/**
 * Loads now and then on an interval, never overlapping requests. A failed refresh keeps the last
 * good data and reports the error, so a brief outage shows as unavailable rather than as empty.
 */
export function usePoll<T>(load: () => Promise<T>, intervalMs: number, key: string): Polled<T> {
  const [data, setData] = useState<T | undefined>(undefined);
  const [error, setError] = useState<unknown>(undefined);
  const [loading, setLoading] = useState(true);
  const loader = useRef(load);
  loader.current = load;
  const running = useRef(false);
  const generation = useRef(0);

  const reload = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    const mine = generation.current;
    try {
      const value = await loader.current();
      if (mine === generation.current) {
        setData(value);
        setError(undefined);
      }
    } catch (caught) {
      if (mine === generation.current) setError(caught);
    } finally {
      running.current = false;
      if (mine === generation.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    generation.current += 1;
    running.current = false;
    setData(undefined);
    setError(undefined);
    setLoading(true);
    void reload();
    const timer = window.setInterval(() => void reload(), intervalMs);
    return () => window.clearInterval(timer);
  }, [key, intervalMs, reload]);

  return { data, error, loading, reload };
}
