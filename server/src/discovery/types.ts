import { z } from 'zod';

export const criteriaSchema = z.object({
  country: z.string().trim().min(2).max(80),
  state: z.string().trim().max(80).optional().default(''),
  city: z.string().trim().max(80).optional().default(''),
  industry: z.string().trim().max(120).optional().default(''),
  keywords: z.string().trim().max(300).optional().default(''),
  maxCompanies: z.number().int().min(1).max(500).default(50),
  maxPagesPerCompany: z.number().int().min(1).max(20).default(6),
});
export type DiscoveryCriteria = z.infer<typeof criteriaSchema>;

export interface DiscoveredCompany {
  providerRef: string;
  name: string;
  website: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
  /** Public page for this record at the source, when one exists. */
  sourceUrl?: string | null;
  raw: unknown;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  message: string;
}

export interface DiscoveryProvider {
  readonly id: string;
  status(): ProviderStatus;
  /** Returns a user-facing reason when the criteria cannot work with this source, before a run starts. */
  validate?(criteria: DiscoveryCriteria): string | null;
  /** `report` receives a human-readable summary of what the source returned (shown on the run). */
  search(criteria: DiscoveryCriteria, shouldStop: () => boolean, report?: (note: string) => void): AsyncGenerator<DiscoveredCompany>;
}

/** Missing or invalid credentials / configuration. Never fall back to invented results. */
export class ProviderConfigError extends Error {
  readonly code = 'PROVIDER_NOT_CONFIGURED';
}
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
  }
}

export function keywordList(c: DiscoveryCriteria): string[] {
  const kws = c.keywords
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);
  if (kws.length) return kws;
  return [c.industry || 'companies'];
}

export function locationText(c: DiscoveryCriteria): string {
  return [c.city, c.state, c.country].filter(Boolean).join(', ');
}
