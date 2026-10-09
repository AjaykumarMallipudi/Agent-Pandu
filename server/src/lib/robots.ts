import robotsParserModule from 'robots-parser';
import { safeFetch } from './http.js';

// The package is CommonJS (module.exports = fn) but its typings declare an ES default export.
type RobotsParserFn = (url: string, body: string) => {
  isAllowed(url: string, ua?: string): boolean | undefined;
  getCrawlDelay(ua?: string): number | undefined;
};
const robotsParser = robotsParserModule as unknown as RobotsParserFn;

export const ROBOTS_UA_TOKEN = 'SmartApplytickBot';

export interface RobotsPolicy {
  isAllowed(url: string): boolean;
  crawlDelayMs?: number;
  note: string;
}

const cache = new Map<string, Promise<RobotsPolicy>>();

export function clearRobotsCache(): void {
  cache.clear();
}

async function load(origin: string): Promise<RobotsPolicy> {
  const robotsUrl = `${origin}/robots.txt`;
  try {
    const res = await safeFetch(robotsUrl, { accept: /^text\/plain|^text\/html|^$/i, maxBytes: 500_000, hostDelayMs: 0 });
    if (res.status === 404 || res.status === 410) return { isAllowed: () => true, note: 'no robots.txt (allow)' };
    if (res.status === 401 || res.status === 403) return { isAllowed: () => false, note: `robots.txt ${res.status} (treated as disallow)` };
    if (res.status >= 400) return { isAllowed: () => false, note: `robots.txt unavailable (${res.status}); not crawling` };
    const parser = robotsParser(robotsUrl, res.body);
    const delay = parser.getCrawlDelay(ROBOTS_UA_TOKEN);
    return {
      // robots-parser returns undefined for URLs outside the robots origin; treat those as not allowed.
      isAllowed: (url) => parser.isAllowed(url, ROBOTS_UA_TOKEN) === true,
      crawlDelayMs: delay ? Math.min(delay * 1000, 30_000) : undefined,
      note: 'robots.txt parsed',
    };
  } catch (e) {
    // RFC 9309: if robots.txt is unreachable due to server/network errors, assume complete disallow.
    return { isAllowed: () => false, note: `robots.txt unreachable (${(e as Error).message}); not crawling` };
  }
}

export function getRobots(origin: string): Promise<RobotsPolicy> {
  let p = cache.get(origin);
  if (!p) {
    p = load(origin);
    cache.set(origin, p);
  }
  return p;
}
