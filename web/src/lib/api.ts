export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'applytick.adminToken';
export function getToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}
export function setToken(t: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, t);
  } catch {
    /* ignore */
  }
}

/** Adds the admin token (if any) to URLs used by EventSource / downloads, which cannot send headers. */
export function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return `${url}${url.includes('?') ? '&' : '?'}token=${encodeURIComponent(t)}`;
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const headers: Record<string, string> = { 'X-Applytick': '1' };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  let body: BodyInit | undefined;
  if (init.form) body = init.form;
  else if (init.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(init.body);
  }
  const res = await fetch(`/api${path}`, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body });
  const text = await res.text();
  const data = text ? (JSON.parse(text) as unknown) : null;
  if (!res.ok) {
    if (res.status === 401) window.dispatchEvent(new Event('applytick:unauthorized'));
    throw new ApiError(res.status, (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

export function qs(params: Record<string, string | number | undefined | null | boolean>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

// ---------- Types ----------
export interface Paged<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface Dashboard {
  companiesDiscovered: number;
  websitesScanned: number;
  contactsFound: number;
  eligibleContacts: number;
  campaignsCreated: number;
  acceptedBySmtp: number;
  confirmedDelivered: number;
  failed: number;
  skipped: number;
  pending: number;
  unknown: number;
  simulated: number;
  contactsByType: { type: string; n: number }[];
  recentRuns: { id: number; status: string; provider: string; companies_found: number; companies_scanned: number; contacts_found: number; started_at: string; finished_at: string | null }[];
  recentCampaigns: { id: number; name: string; status: string; test_mode: number; created_at: string }[];
}

export interface Company {
  id: number;
  name: string;
  domain: string | null;
  website_url: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  industry: string | null;
  address?: string | null;
  discovery_status: string;
  scan_error: string | null;
  pages_scanned: number;
  last_scanned_at: string | null;
  created_at: string;
  contact_count?: number;
}

export type Eligibility = 'eligible' | 'suppressed' | 'contacted' | 'invalid' | 'low_confidence';

export interface Contact {
  id: number;
  email: string;
  name: string | null;
  role_title: string | null;
  contact_type: string;
  confidence: number;
  domain_matches_company: number;
  mx_checked: number;
  mx_valid: number | null;
  last_seen_at: string;
  company_id: number;
  company_name: string;
  city: string | null;
  state: string | null;
  country: string | null;
  eligibility: Eligibility;
}

export interface Evidence {
  source_url: string;
  page_type: string;
  method: string;
  context_snippet: string | null;
  created_at: string;
}

export interface DiscoveryRun {
  id: number;
  status: string;
  provider: string;
  criteria: Criteria;
  current_step: string | null;
  companies_found: number;
  companies_scanned: number;
  contacts_found: number;
  error_count: number;
  errors: string[];
  started_at: string;
  finished_at: string | null;
}

export interface Criteria {
  country: string;
  state: string;
  city: string;
  industry: string;
  keywords: string;
  maxCompanies: number;
  maxPagesPerCompany: number;
}

export interface ProviderStatus {
  id: string;
  label: string;
  configured: boolean;
  message: string;
}

export interface Template {
  id: number;
  name: string;
  subject: string;
  html: string;
  text: string;
  attach_resume: number;
  created_at: string;
  updated_at: string;
}

export interface Rendered {
  subject: string;
  html: string;
  text: string;
}

export type Counts = Record<
  'draft' | 'excluded' | 'queued' | 'processing' | 'accepted' | 'delivered' | 'bounced' | 'failed' | 'skipped' | 'unknown' | 'simulated',
  number
> & { total: number; finished: number; progress: number };

export interface Campaign {
  id: number;
  name: string;
  template_id: number | null;
  template_name: string | null;
  position: string | null;
  attach_resume: number;
  status: string;
  test_mode: number;
  paused_reason: string | null;
  approved_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  counts?: Counts;
}

export interface CampaignMessage {
  id: number;
  email: string;
  recipient_name: string | null;
  company_name: string | null;
  contact_type: string | null;
  subject: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
  attempts: number;
  next_attempt_at: string | null;
  processed_at: string | null;
  delivered_at: string | null;
  smtp_message_id: string | null;
  smtp_response: string | null;
}

export interface CampaignSnapshot {
  campaign: Campaign;
  counts: Counts;
  messages: CampaignMessage[];
  killSwitch: boolean;
  testMode: boolean;
}

export interface RuntimeSettings {
  maxRecipientsPerCampaign: 50 | 100;
  sendRatePerMinute: number;
  sendDailyLimit: number;
  sendConcurrency: number;
  minConfidence: number;
  testMode: boolean;
  killSwitch: boolean;
  testModeLockedByEnv: boolean;
  killSwitchLockedByEnv: boolean;
}

export interface SettingsView {
  runtime: RuntimeSettings;
  smtp: { configured: boolean; missing: string[]; host: string; port: number; secure: boolean; user: string; from: string; senderName: string; testAddress: string };
  discovery: { active: ProviderStatus; providers: ProviderStatus[] };
  crawl: { userAgent: string; timeoutMs: number; maxBytes: number; maxRedirects: number; hostDelayMs: number; concurrency: number; checkMx: boolean };
  limits: { envRatePerMinute: number; envDailyLimit: number; envConcurrency: number };
  resume: { uploaded: boolean; size?: number; updatedAt?: string };
  security: { host: string; loopbackOnly: boolean; adminTokenSet: boolean };
  publicBaseUrl: string | null;
  sender: { name: string; phone: string; linkedin: string; github: string; portfolio: string };
}

export const CONTACT_TYPES = ['HR', 'Recruiter', 'Recruitment', 'Talent Acquisition', 'Careers', 'Hiring', 'General Contact', 'Founder', 'CEO', 'Other'];
