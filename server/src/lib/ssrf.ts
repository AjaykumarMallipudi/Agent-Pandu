import dns from 'node:dns';
import net from 'node:net';
import ipaddr from 'ipaddr.js';

export class SsrfError extends Error {
  readonly code = 'SSRF_BLOCKED';
}

export type Resolver = (host: string) => Promise<{ address: string; family: number }[]>;

const defaultResolver: Resolver = (host) => dns.promises.lookup(host, { all: true, verbatim: true });
let resolver: Resolver = defaultResolver;

/** Test hook to replace DNS resolution. Pass nothing to restore the system resolver. */
export function setResolver(r?: Resolver): void {
  resolver = r ?? defaultResolver;
}

/** Only globally routable unicast addresses are allowed. */
export function isPublicIp(ip: string): boolean {
  if (!ipaddr.isValid(ip)) return false;
  let addr = ipaddr.parse(ip);
  if (addr.kind() === 'ipv6' && (addr as ipaddr.IPv6).isIPv4MappedAddress()) {
    addr = (addr as ipaddr.IPv6).toIPv4Address();
  }
  return addr.range() === 'unicast';
}

const ALLOWED_PORTS = new Set(['', '80', '443']);

/** Throws SsrfError unless the URL is http(s), on a standard port, and resolves only to public addresses. */
export async function assertPublicUrl(rawUrl: string): Promise<URL> {
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    throw new SsrfError(`Invalid URL: ${rawUrl}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new SsrfError(`Blocked protocol ${u.protocol}`);
  if (u.username || u.password) throw new SsrfError('Blocked URL with credentials');
  if (!ALLOWED_PORTS.has(u.port)) throw new SsrfError(`Blocked non-standard port ${u.port}`);
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host)) {
    if (!isPublicIp(host)) throw new SsrfError(`Blocked private address ${host}`);
    return u;
  }
  if (/^(localhost|.*\.localhost|.*\.local|.*\.internal|.*\.lan|.*\.home\.arpa)$/i.test(host)) {
    throw new SsrfError(`Blocked internal hostname ${host}`);
  }
  let addrs: { address: string }[];
  try {
    addrs = await resolver(host);
  } catch (e) {
    throw new SsrfError(`DNS resolution failed for ${host}: ${(e as Error).message}`);
  }
  if (addrs.length === 0) throw new SsrfError(`No DNS records for ${host}`);
  const bad = addrs.find((a) => !isPublicIp(a.address));
  if (bad) throw new SsrfError(`Blocked: ${host} resolves to non-public address ${bad.address}`);
  return u;
}

/**
 * `lookup` implementation for http(s).Agent that re-validates addresses at connect time,
 * closing the DNS-rebinding gap between validation and connection.
 */
export function safeLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family?: number) => void,
): void {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => !isPublicIp(a.address));
    if (bad || list.length === 0) {
      const e = new SsrfError(`Blocked connection to non-public address for ${hostname}`) as unknown as NodeJS.ErrnoException;
      return callback(e, '', 0);
    }
    if (options.all) return callback(null, list);
    const first = list[0]!;
    callback(null, first.address, first.family);
  });
}
