import fs from 'node:fs';
import path from 'node:path';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { approveCampaign, createCampaign, startCampaign } from '../src/campaigns/service.js';
import { CampaignWorker } from '../src/campaigns/worker.js';
import { getDb, initDb } from '../src/db/index.js';
import { buildContext, ensureDefaultTemplate, renderTemplate, RESUME_BUTTON_TEMPLATE } from '../src/email/templates.js';
import { exportSnapshot, importSnapshot, importSnapshotIfEmpty, snapshotDir } from '../src/export/snapshot.js';
import { isInstitutionalDomain } from '../src/lib/url.js';
import { updateSettings } from '../src/settings.js';
import { defaultTemplateId, installMockSmtp, messages, setupTestEnv, type MockSmtp } from './helpers.js';

const H = { 'X-Applytick': '1' };

function company(name: string, domain: string): number {
  return Number(getDb().prepare(`INSERT INTO companies (name, domain, website_url, discovery_status, city, country) VALUES (?, ?, ?, 'scanned', 'Hyderabad', 'India')`).run(name, domain, `https://${domain}/`).lastInsertRowid);
}
function contact(companyId: number, email: string, type: string, confidence = 80): number {
  return Number(
    getDb()
      .prepare(`INSERT INTO contacts (company_id, email, contact_type, syntax_valid, domain_matches_company, confidence, confidence_explanation) VALUES (?, ?, ?, 1, 1, ?, '["x"]')`)
      .run(companyId, email, type, confidence).lastInsertRowid,
  );
}

let smtp: MockSmtp;
let worker: CampaignWorker;
beforeEach(() => {
  setupTestEnv();
  smtp = installMockSmtp();
  worker = new CampaignWorker();
});
afterEach(async () => {
  await worker.stop();
});

async function send(contactIds: number[]) {
  const c = createCampaign({ name: 'c', templateId: defaultTemplateId(), contactIds });
  const n = messages(c.id).filter((m) => m.status === 'draft').length;
  approveCampaign(c.id, { confirm: true, recipientCount: n });
  startCampaign(c.id);
  for (let i = 0; i < 20; i++) {
    await worker.tick();
    await worker.drain();
  }
  return c.id;
}

describe('one contact per company', () => {
  it('lists only the best eligible contact per company (HR before general, then confidence)', async () => {
    const a = company('Acme', 'acme.com');
    contact(a, 'info@acme.com', 'General Contact', 95);
    const hr = contact(a, 'hr@acme.com', 'HR', 70);
    contact(a, 'sales@acme.com', 'Other', 90);
    const b = company('Beta', 'beta.com');
    const careers = contact(b, 'careers@beta.com', 'Careers', 80);
    company('Empty Co', 'empty.com'); // zero contacts

    const app = createApp();
    const best = await request(app).get('/api/contacts?bestPerCompany=1&sort=priority');
    expect(best.body.items.map((c: { id: number }) => c.id)).toEqual([hr, careers]);
    expect(best.body.items[0].company_contact_count).toBe(3);
    const ids = await request(app).get('/api/contacts/eligible-ids');
    expect(ids.body.ids).toEqual([hr, careers]); // one per company by default

    const withContacts = await request(app).get('/api/companies?contacts=with');
    expect(withContacts.body.items.map((c: { name: string }) => c.name).sort()).toEqual(['Acme', 'Beta']);
    const without = await request(app).get('/api/companies?contacts=without');
    expect(without.body.items.map((c: { name: string }) => c.name)).toEqual(['Empty Co']);
  });

  it('keeps one recipient per company in a campaign even if several are selected', () => {
    const a = company('Acme', 'acme.com');
    const ids = [contact(a, 'info@acme.com', 'General Contact', 95), contact(a, 'hr@acme.com', 'HR', 70), contact(a, 'jobs@acme.com', 'Hiring', 80)];
    const c = createCampaign({ name: 'x', templateId: defaultTemplateId(), contactIds: ids });
    const byEmail = Object.fromEntries(messages(c.id).map((m) => [m.email, m]));
    expect(byEmail['hr@acme.com']!.status).toBe('draft');
    expect(byEmail['info@acme.com']).toMatchObject({ status: 'skipped', error_message: 'One contact per company: sending to hr@acme.com instead' });
    expect(byEmail['jobs@acme.com']!.status).toBe('skipped');
  });

  it('never contacts a second person at a company that was already emailed', async () => {
    const a = company('Acme', 'acme.com');
    const hr = contact(a, 'hr@acme.com', 'HR');
    const info = contact(a, 'info@acme.com', 'General Contact');
    await send([hr]);
    expect(smtp.sent).toHaveLength(1);
    const st = await request(createApp()).get(`/api/contacts/${info}`);
    expect(st.body.contact.eligibility).toBe('company_contacted');
    const c2 = createCampaign({ name: 'again', templateId: defaultTemplateId(), contactIds: [info] });
    expect(messages(c2.id)[0]).toMatchObject({ status: 'skipped', error_message: expect.stringMatching(/already contacted/) });
  });

  it('can be switched off in settings', () => {
    updateSettings({ onePerCompany: false });
    const a = company('Acme', 'acme.com');
    const c = createCampaign({ name: 'x', templateId: defaultTemplateId(), contactIds: [contact(a, 'hr@acme.com', 'HR'), contact(a, 'info@acme.com', 'General Contact')] });
    expect(messages(c.id).map((m) => m.status)).toEqual(['draft', 'draft']);
  });
});

describe('institutional sites', () => {
  it('treats universities and government domains as non-companies', () => {
    for (const d of ['serc.iiit.ac.in', 'iitb.ac.in', 'mit.edu', 'telangana.gov.in', 'x.nic.in']) expect(isInstitutionalDomain(d), d).toBe(true);
    for (const d of ['acme.com', 'acme.co.in', 'education-startup.com']) expect(isInstitutionalDomain(d), d).toBe(false);
  });
});

describe('resume button template', () => {
  it('renders a centred blue button to the resume link and no header', () => {
    updateSettings({ resumeUrl: 'https://drive.google.com/file/d/abc123/view?usp=sharing' });
    const r = renderTemplate(RESUME_BUTTON_TEMPLATE, buildContext({ name: null, company: 'Acme', position: 'Software Engineer' }));
    expect(r.subject).toBe('Application for Software Engineer at Acme — Jane Applicant');
    expect(r.html).toContain('href="https://drive.google.com/file/d/abc123/view?usp=sharing"');
    expect(r.html).toMatch(/<td align="center">\s*<a href="https:\/\/drive\.google\.com[^>]+background:#2563eb[^>]*>View My Resume<\/a>/);
    expect(r.html.indexOf('Best regards')).toBeLessThan(r.html.indexOf('View My Resume')); // button after all content
    expect(r.html).not.toMatch(/height:6px/); // no coloured header bar
    expect(r.text).toContain('My resume: https://drive.google.com/file/d/abc123/view?usp=sharing');
    expect(r.html).toContain('Dear Hiring Team,');
  });

  it('omits the button when no resume link is set, and requires https links', async () => {
    const r = renderTemplate(RESUME_BUTTON_TEMPLATE, buildContext({ company: 'Acme' }));
    expect(r.html).not.toContain('View My Resume');
    const bad = await request(createApp()).put('/api/settings').set(H).send({ resumeUrl: 'http://insecure.example/cv' });
    expect(bad.status).toBe(400);
    const ok = await request(createApp()).put('/api/settings').set(H).send({ resumeUrl: 'https://drive.google.com/file/d/x/view' });
    expect(ok.body.runtime.resumeUrl).toBe('https://drive.google.com/file/d/x/view');
  });

  it('is installed once and not re-added after the user deletes it', () => {
    const names = () => (getDb().prepare('SELECT name FROM email_templates ORDER BY id').all() as { name: string }[]).map((t) => t.name);
    expect(names()).toEqual(['Simple — resume button', 'Professional introduction']);
    getDb().prepare(`DELETE FROM email_templates WHERE name = 'Simple — resume button'`).run();
    ensureDefaultTemplate();
    expect(names()).toEqual(['Professional introduction']);
  });
});

describe('data snapshot (data/snapshot/*.json)', () => {
  it('round-trips companies, contacts, evidence, opt-outs, contacted list and templates to a fresh database', async () => {
    const a = company('Acme', 'acme.com');
    getDb().prepare(`INSERT INTO company_sources (company_id, provider, provider_ref, source_url) VALUES (?, 'osm', 'node/1', 'https://www.openstreetmap.org/node/1')`).run(a);
    const hr = contact(a, 'hr@acme.com', 'HR');
    contact(a, 'info@acme.com', 'General Contact');
    getDb().prepare(`INSERT INTO contact_evidence (contact_id, source_url, page_type, method, context_snippet) VALUES (?, 'https://acme.com/careers', 'careers', 'mailto', 'HR team')`).run(hr);
    const b = company('Beta', 'beta.com');
    const jobs = contact(b, 'jobs@beta.com', 'Hiring');
    getDb().prepare(`INSERT INTO suppressions (email, reason, source) VALUES ('optout@x.com', 'replied unsubscribe', 'manual')`).run();
    await send([jobs]); // jobs@beta.com is now contacted

    const r = exportSnapshot();
    expect(r).toMatchObject({ companies: 2, contacts: 3, suppressions: 1, contacted: 1, templates: 2 });
    const dir = snapshotDir();
    for (const f of ['companies.json', 'contacts.json', 'suppressions.json', 'contacted.json', 'templates.json', 'meta.json']) {
      expect(fs.existsSync(path.join(dir, f)), f).toBe(true);
    }
    const json = fs.readFileSync(path.join(dir, 'contacts.json'), 'utf8');
    expect(json).not.toMatch(/SMTP|password/i);
    const first = JSON.parse(json)[0];
    expect(first).toMatchObject({ email: 'hr@acme.com', company_key: 'acme.com', evidence: [{ source_url: 'https://acme.com/careers' }] });

    // "Clone on another machine": empty database, same data folder.
    initDb(':memory:');
    importSnapshotIfEmpty();
    ensureDefaultTemplate();
    expect(getDb().prepare('SELECT COUNT(*) n FROM companies').get()).toEqual({ n: 2 });
    expect(getDb().prepare('SELECT COUNT(*) n FROM contacts').get()).toEqual({ n: 3 });
    expect(getDb().prepare('SELECT COUNT(*) n FROM contact_evidence').get()).toEqual({ n: 1 });
    expect(getDb().prepare('SELECT source_url FROM company_sources').get()).toEqual({ source_url: 'https://www.openstreetmap.org/node/1' });
    expect(getDb().prepare('SELECT email FROM suppressions').get()).toEqual({ email: 'optout@x.com' });
    expect(getDb().prepare('SELECT email, company_domain FROM contacted_history').get()).toEqual({ email: 'jobs@beta.com', company_domain: 'beta.com' });

    // The already-emailed address and its company stay blocked on the new machine.
    const app = createApp();
    const list = await request(app).get('/api/contacts?pageSize=10');
    const status = Object.fromEntries(list.body.items.map((c: { email: string; eligibility: string }) => [c.email, c.eligibility]));
    expect(status).toEqual({ 'hr@acme.com': 'eligible', 'info@acme.com': 'eligible', 'jobs@beta.com': 'contacted' });

    // Importing twice adds nothing.
    expect(importSnapshot().added).toEqual({ companies: 0, contacts: 0, suppressions: 0, contacted: 0, templates: 0 });
  });

  it('never re-sends to an address from imported history, even if forced into a campaign', async () => {
    const a = company('Acme', 'acme.com');
    const hr = contact(a, 'hr@acme.com', 'HR');
    updateSettings({ onePerCompany: false });
    const c = createCampaign({ name: 'x', templateId: defaultTemplateId(), contactIds: [hr] });
    approveCampaign(c.id, { confirm: true, recipientCount: 1 });
    getDb().prepare(`INSERT INTO contacted_history (email, company_domain, contacted_at, source) VALUES ('hr@acme.com', 'acme.com', '2026-01-01', 'snapshot')`).run();
    startCampaign(c.id);
    await worker.tick();
    await worker.drain();
    expect(smtp.sent).toHaveLength(0);
    expect(messages(c.id)[0]).toMatchObject({ status: 'skipped', error_code: 'DUPLICATE' });
  });

  it('exposes export/import/status over the API', async () => {
    company('Acme', 'acme.com');
    const app = createApp();
    expect((await request(app).post('/api/data/export').set(H)).body.companies).toBe(1);
    const st = await request(app).get('/api/data/snapshot');
    expect(st.body).toMatchObject({ exists: true, meta: { counts: { companies: 1 } } });
    expect((await request(app).post('/api/data/import').set(H)).status).toBe(200);
  });
});
