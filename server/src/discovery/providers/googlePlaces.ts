import axios from 'axios';
import { config } from '../../config.js';
import {
  keywordList,
  locationText,
  ProviderConfigError,
  ProviderError,
  type DiscoveredCompany,
  type DiscoveryCriteria,
  type DiscoveryProvider,
} from '../types.js';

export const PLACES_ENDPOINT = 'https://places.googleapis.com/v1/places:searchText';
const FIELD_MASK = [
  'places.id',
  'places.displayName',
  'places.formattedAddress',
  'places.websiteUri',
  'places.addressComponents',
  'places.primaryTypeDisplayName',
  'nextPageToken',
].join(',');

interface Place {
  id: string;
  displayName?: { text?: string };
  formattedAddress?: string;
  websiteUri?: string;
  addressComponents?: { longText?: string; types?: string[] }[];
  primaryTypeDisplayName?: { text?: string };
}

function component(p: Place, type: string): string | null {
  return p.addressComponents?.find((c) => c.types?.includes(type))?.longText ?? null;
}

/** Google Places API (New) — Text Search. Official, documented API; requires GOOGLE_PLACES_API_KEY. */
export class GooglePlacesProvider implements DiscoveryProvider {
  readonly id = 'google_places';

  status() {
    const key = config().GOOGLE_PLACES_API_KEY;
    return {
      id: this.id,
      label: 'Google Places API (New) — Text Search',
      configured: Boolean(key),
      message: key
        ? 'API key configured.'
        : 'GOOGLE_PLACES_API_KEY is not set. Create a key in Google Cloud Console, enable "Places API (New)", add it to .env and restart the server.',
    };
  }

  async *search(c: DiscoveryCriteria, shouldStop: () => boolean): AsyncGenerator<DiscoveredCompany> {
    const key = config().GOOGLE_PLACES_API_KEY;
    if (!key) throw new ProviderConfigError(this.status().message);
    const seen = new Set<string>();
    let yielded = 0;
    for (const kw of keywordList(c)) {
      const textQuery = `${kw}${c.industry && kw !== c.industry ? ` ${c.industry}` : ''} in ${locationText(c)}`;
      let pageToken: string | undefined;
      // Text Search returns at most 3 pages of 20 results per query.
      for (let page = 0; page < 3; page++) {
        if (shouldStop() || yielded >= c.maxCompanies) return;
        let data: { places?: Place[]; nextPageToken?: string };
        try {
          const res = await axios.post(
            PLACES_ENDPOINT,
            { textQuery, pageSize: 20, ...(pageToken ? { pageToken } : {}) },
            {
              timeout: 20000,
              headers: { 'Content-Type': 'application/json', 'X-Goog-Api-Key': key, 'X-Goog-FieldMask': FIELD_MASK },
            },
          );
          data = res.data;
        } catch (e) {
          if (axios.isAxiosError(e)) {
            const status = e.response?.status;
            const msg = (e.response?.data as { error?: { message?: string } })?.error?.message ?? e.message;
            if (status === 400 || status === 401 || status === 403) {
              throw new ProviderConfigError(`Google Places rejected the request (${status}): ${msg}`);
            }
            throw new ProviderError(`Google Places request failed${status ? ` (${status})` : ''}: ${msg}`, status);
          }
          throw e;
        }
        for (const p of data.places ?? []) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          yield {
            providerRef: p.id,
            name: p.displayName?.text ?? 'Unknown',
            website: p.websiteUri ?? null,
            address: p.formattedAddress ?? null,
            city: component(p, 'locality') ?? (c.city || null),
            state: component(p, 'administrative_area_level_1') ?? (c.state || null),
            country: component(p, 'country') ?? c.country,
            industry: c.industry || p.primaryTypeDisplayName?.text || null,
            raw: p,
          };
          if (++yielded >= c.maxCompanies) return;
        }
        pageToken = data.nextPageToken;
        if (!pageToken) break;
      }
    }
  }
}
