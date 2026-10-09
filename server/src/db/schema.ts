/** Ordered migrations. Each entry runs once, tracked via PRAGMA user_version. */
export const migrations: string[] = [
  `
  CREATE TABLE companies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    domain TEXT UNIQUE,                       -- normalized host, NULL when no website
    website_url TEXT,
    country TEXT, state TEXT, city TEXT, address TEXT,
    industry TEXT,
    discovery_status TEXT NOT NULL DEFAULT 'discovered',
    scan_error TEXT,
    pages_scanned INTEGER NOT NULL DEFAULT 0,
    last_scanned_at TEXT,
    last_run_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX ix_companies_status ON companies(discovery_status);
  CREATE INDEX ix_companies_location ON companies(country, state, city);
  CREATE INDEX ix_companies_name ON companies(name);

  CREATE TABLE company_sources (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    provider_ref TEXT NOT NULL,
    run_id INTEGER,
    raw_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(provider, provider_ref)
  );
  CREATE INDEX ix_company_sources_company ON company_sources(company_id);

  CREATE TABLE contacts (
    id INTEGER PRIMARY KEY,
    company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
    email TEXT NOT NULL UNIQUE,               -- normalized (lower-case, trimmed)
    name TEXT,
    role_title TEXT,
    contact_type TEXT NOT NULL,
    syntax_valid INTEGER NOT NULL,
    domain_matches_company INTEGER NOT NULL,
    mx_checked INTEGER NOT NULL DEFAULT 0,
    mx_valid INTEGER,                         -- NULL when not checked
    confidence INTEGER NOT NULL,
    confidence_explanation TEXT NOT NULL,     -- JSON array of strings
    status TEXT NOT NULL DEFAULT 'active',    -- active | invalid
    first_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    last_seen_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX ix_contacts_company ON contacts(company_id);
  CREATE INDEX ix_contacts_type ON contacts(contact_type);
  CREATE INDEX ix_contacts_confidence ON contacts(confidence);

  CREATE TABLE contact_evidence (
    id INTEGER PRIMARY KEY,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    source_url TEXT NOT NULL,
    page_type TEXT NOT NULL,
    method TEXT NOT NULL,                     -- mailto | text | obfuscated
    context_snippet TEXT,
    run_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(contact_id, source_url, method)
  );

  CREATE TABLE discovery_runs (
    id INTEGER PRIMARY KEY,
    status TEXT NOT NULL,                     -- running | completed | failed | cancelled | interrupted
    provider TEXT NOT NULL,
    criteria_json TEXT NOT NULL,
    current_step TEXT,
    companies_found INTEGER NOT NULL DEFAULT 0,
    companies_scanned INTEGER NOT NULL DEFAULT 0,
    contacts_found INTEGER NOT NULL DEFAULT 0,
    error_count INTEGER NOT NULL DEFAULT 0,
    errors_json TEXT NOT NULL DEFAULT '[]',
    cancel_requested INTEGER NOT NULL DEFAULT 0,
    started_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    finished_at TEXT
  );
  -- Only one discovery run may be active at a time.
  CREATE UNIQUE INDEX ux_discovery_single_running ON discovery_runs(status) WHERE status = 'running';

  CREATE TABLE email_templates (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    attach_resume INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE campaigns (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    template_id INTEGER REFERENCES email_templates(id) ON DELETE SET NULL,
    template_name TEXT,
    position TEXT,
    attach_resume INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'draft',     -- draft | approved | sending | paused | completed | cancelled
    test_mode INTEGER NOT NULL,
    paused_reason TEXT,
    approved_at TEXT, started_at TEXT, completed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE campaign_messages (
    id INTEGER PRIMARY KEY,
    campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
    contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    email TEXT NOT NULL,
    recipient_name TEXT,
    company_name TEXT,
    contact_type TEXT,
    subject TEXT NOT NULL,
    html TEXT NOT NULL,
    text TEXT NOT NULL,
    status TEXT NOT NULL,                     -- draft|excluded|queued|processing|accepted|delivered|failed|skipped|unknown|simulated
    error_code TEXT,
    error_message TEXT,
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT,
    submit_started_at TEXT,
    processed_at TEXT,
    delivered_at TEXT,
    smtp_message_id TEXT,
    smtp_response TEXT,
    idempotency_key TEXT NOT NULL UNIQUE,
    unsubscribe_token TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    UNIQUE(campaign_id, email)
  );
  CREATE INDEX ix_messages_campaign_status ON campaign_messages(campaign_id, status);
  CREATE INDEX ix_messages_status ON campaign_messages(status);
  CREATE INDEX ix_messages_processed ON campaign_messages(processed_at);

  -- One live reservation / successful send per address across all campaigns.
  CREATE TABLE send_ledger (
    email TEXT PRIMARY KEY,
    message_id INTEGER NOT NULL REFERENCES campaign_messages(id) ON DELETE CASCADE,
    state TEXT NOT NULL,                      -- reserved | accepted | unknown
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE suppressions (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE,
    reason TEXT NOT NULL,
    source TEXT NOT NULL,                     -- manual | unsubscribe_link | bounce | complaint
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );

  CREATE TABLE events (
    id INTEGER PRIMARY KEY,
    type TEXT NOT NULL,
    entity_type TEXT,
    entity_id INTEGER,
    message TEXT NOT NULL,
    data_json TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE INDEX ix_events_entity ON events(entity_type, entity_id);
  `,
  `
  -- Public link to the record at the discovery source (e.g. https://www.openstreetmap.org/node/123).
  ALTER TABLE company_sources ADD COLUMN source_url TEXT;

  -- Response cache for public APIs (Nominatim usage policy requires caching repeated queries).
  CREATE TABLE api_cache (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
  `,
];
