import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

interface Selection {
  ids: number[];
  has(id: number): boolean;
  toggle(id: number): void;
  add(ids: number[]): void;
  remove(ids: number[]): void;
  clear(): void;
}

const Ctx = createContext<Selection | null>(null);
const KEY = 'applytick.selection';

function load(): number[] {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is number => typeof x === 'number') : [];
  } catch {
    return [];
  }
}

/** Contact selection shared between the Contacts page and campaign creation; survives reloads in this tab. */
export function SelectionProvider({ children }: { children: ReactNode }) {
  const [ids, setIds] = useState<number[]>(load);
  useEffect(() => {
    try {
      sessionStorage.setItem(KEY, JSON.stringify(ids));
    } catch {
      /* ignore */
    }
  }, [ids]);
  const set = useMemo(() => new Set(ids), [ids]);
  const has = useCallback((id: number) => set.has(id), [set]);
  const toggle = useCallback((id: number) => setIds((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : [...cur, id])), []);
  const add = useCallback((more: number[]) => setIds((cur) => [...new Set([...cur, ...more])]), []);
  const remove = useCallback((less: number[]) => setIds((cur) => cur.filter((x) => !less.includes(x))), []);
  const clear = useCallback(() => setIds([]), []);
  return <Ctx.Provider value={{ ids, has, toggle, add, remove, clear }}>{children}</Ctx.Provider>;
}

export function useSelection(): Selection {
  const c = useContext(Ctx);
  if (!c) throw new Error('SelectionProvider missing');
  return c;
}
