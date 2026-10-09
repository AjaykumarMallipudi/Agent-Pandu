import dns from 'node:dns';

export type MxResolver = (domain: string) => Promise<boolean>;

const defaultMx: MxResolver = async (domain) => {
  try {
    const records = await dns.promises.resolveMx(domain);
    return records.some((r) => r.exchange && r.exchange !== '.');
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'ENOTFOUND' || code === 'ENODATA') return false;
    throw e; // transient DNS failure: treat as "not checked"
  }
};

let resolver: MxResolver = defaultMx;
const cache = new Map<string, Promise<boolean | null>>();

export function setMxResolver(r?: MxResolver): void {
  resolver = r ?? defaultMx;
  cache.clear();
}

/** Returns true/false when the check ran, or null if it could not be performed. */
export function checkMx(domain: string): Promise<boolean | null> {
  let p = cache.get(domain);
  if (!p) {
    p = resolver(domain).catch(() => null);
    cache.set(domain, p);
  }
  return p;
}
