import fs from 'node:fs';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.js';
import { getDb } from '../src/db/index.js';
import { buildContext, DEFAULT_TEMPLATE, renderTemplate, TemplateError, validateTemplateSource } from '../src/email/templates.js';
import { exportCampaignHistory, exportCompanies, exportContacts, safeCell } from '../src/export/excel.js';
import { insertContact, installMockSmtp, setupTestEnv } from './helpers.js';

const H = { 'X-Applytick': '1' };

describe('HTML templates', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('escapes interpolated values in HTML', () => {
    const r = renderTemplate(
      { subject: 'Hi {{name}}', html: '<p>Dear {{name}} at {{company}}</p>', text: 'Dear {{name}}' },
      buildContext({ name: '<script>alert(1)</script>', company: 'A & B "Co"' }),
    );
    expect(r.html).not.toContain('<script>');
    expect(r.html).toContain('&lt;script&gt;');
    expect(r.html).toContain('A &amp; B');
    // Plain text and subject are not HTML: no entity noise there.
    expect(r.text).toContain('Dear <script>alert(1)</script>');
    expect(r.subject).toBe('Hi <script>alert(1)</script>');
  });

  it('strips header-injection newlines from subject values', () => {
    const r = renderTemplate({ subject: 'Hi {{company}}', html: '<p>x</p>', text: 'x' }, buildContext({ company: 'Evil\r\nBcc: victim@x.com' }));
    expect(r.subject).toBe('Hi Evil Bcc: victim@x.com');
  });

  it('sanitizes edited HTML', () => {
    const r = renderTemplate(
      {
        subject: 's',
        html: '<p onclick="x()">ok</p><script>bad()</script><img src="javascript:alert(1)" onerror="x"><a href="javascript:alert(1)">l</a><iframe src="https://x"></iframe><style>body{}</style>',
        text: 't',
      },
      buildContext({}),
    );
    expect(r.html).not.toMatch(/onclick|onerror|<script|javascript:|<iframe|bad\(\)/i);
    expect(r.html).toContain('<p>ok</p>');
  });

  it('rejects unsafe or unknown template constructs', () => {
    expect(() => validateTemplateSource('{{{name}}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{& name}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{password}}', 'HTML')).toThrow(/unknown placeholder/);
    expect(() => validateTemplateSource('{{> partial}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{lookup this "x"}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{#each name}}x{{/each}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{../name}}', 'HTML')).toThrow(TemplateError);
    expect(() => validateTemplateSource('{{#if linkedin}}<a href="{{linkedin}}">x</a>{{/if}}', 'HTML')).not.toThrow();
  });

  it('uses a safe fallback greeting and renders the default design', () => {
    const r = renderTemplate(DEFAULT_TEMPLATE, buildContext({ name: null, company: 'Acme', role: 'HR' }));
    expect(r.html).toContain('Dear Hiring Team,');
    expect(r.text).toContain('Dear Hiring Team,');
    expect(r.html).toContain('href="https://linkedin.com/in/jane"');
    expect(r.html).toContain('<!DOCTYPE html>');
    expect(r.text).toMatch(/unsubscribe/);
    expect(r.subject).toBe('Application from Jane Applicant');
  });

  it('appends an opt-out notice when a template lacks one', () => {
    const r = renderTemplate({ subject: 's', html: '<p>Hello</p>', text: 'Hello' }, buildContext({ company: 'Acme' }));
    expect(r.html).toMatch(/reply "unsubscribe"|reply &quot;unsubscribe&quot;/);
    expect(r.text).toMatch(/reply "unsubscribe"/);
  });

  it('supports CRUD, duplicate and preview over the API', async () => {
    const app = createApp();
    const created = await request(app).post('/api/templates').set(H).send({ name: 'T1', subject: 'Hi {{name}}', html: '<p>{{company}}</p>', text: '{{company}}', attachResume: false });
    expect(created.status).toBe(201);
    const bad = await request(app).post('/api/templates').set(H).send({ name: 'T2', subject: '{{{name}}}', html: '<p>x</p>', text: 'x' });
    expect(bad.status).toBe(400);
    const dup = await request(app).post(`/api/templates/${created.body.id}/duplicate`).set(H);
    expect(dup.body.name).toBe('T1 (copy)');
    const preview = await request(app).post('/api/templates/preview').set(H).send({ subject: 'Hi {{name}}', html: '<p>{{company}}</p>', text: 'x' });
    expect(preview.body.subject).toBe('Hi Priya Sharma');
    expect(preview.body.html).toContain('Example Technologies');
    const upd = await request(app).put(`/api/templates/${created.body.id}`).set(H).send({ name: 'T1', subject: 'New', html: '<p>x</p>', text: 'x' });
    expect(upd.body.subject).toBe('New');
    expect((await request(app).delete(`/api/templates/${dup.body.id}`).set(H)).status).toBe(200);
  });

  it('sends test emails only to the configured test address', async () => {
    const smtp = installMockSmtp();
    const res = await request(createApp()).post('/api/templates/1/test-email').set(H).send({});
    expect(res.status).toBe(200);
    expect(smtp.sent).toHaveLength(1);
    expect(smtp.sent[0]!.to).toBe('jane+test@sender.dev');
    expect(String(smtp.sent[0]!.subject)).toMatch(/^\[TEST\]/);
  });
});

describe('Excel export', () => {
  beforeEach(() => {
    setupTestEnv();
  });

  it('neutralizes formula injection', () => {
    expect(safeCell('=HYPERLINK("http://x","y")')).toBe(`'=HYPERLINK("http://x","y")`);
    expect(safeCell('+1+1')).toBe("'+1+1");
    expect(safeCell('-2')).toBe("'-2");
    expect(safeCell('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(safeCell('\tcmd')).toBe("'\tcmd");
    expect(safeCell('normal')).toBe('normal');
    expect(safeCell(42)).toBe(42);
    expect(safeCell(null)).toBeNull();
  });

  it('writes contacts.xlsx with frozen header, filters and escaped cells', async () => {
    insertContact({ email: 'hr@a.com', name: '=cmd|calc', company: '@evil' });
    insertContact({ email: 'jobs@b.com' });
    const file = await exportContacts();
    expect(file.endsWith('contacts.xlsx')).toBe(true);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.getWorksheet('Contacts')!;
    expect(ws.views[0]).toMatchObject({ state: 'frozen', ySplit: 1 });
    expect(ws.autoFilter).toBeTruthy();
    expect(ws.getRow(1).getCell(2).value).toBe('Email');
    const values = ws.getSheetValues().flat().map(String);
    expect(values).toContain("'=cmd|calc");
    expect(values).toContain("'@evil");
    expect(ws.rowCount).toBe(3);
  });

  it('exports selected contacts, companies and campaign history', async () => {
    const a = insertContact({ email: 'a@a.com' });
    insertContact({ email: 'b@b.com' });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(await exportContacts([a]));
    expect(wb.getWorksheet('Contacts')!.rowCount).toBe(2);
    expect(fs.existsSync(await exportCompanies())).toBe(true);
    expect(fs.existsSync(await exportCampaignHistory())).toBe(true);
    const res = await request(createApp()).get('/api/export/contacts.xlsx?ids=' + a);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/spreadsheetml/);
    expect(getDb()).toBeTruthy();
  });
});
