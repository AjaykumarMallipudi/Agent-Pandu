import fs from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { config } from '../config.js';
import { getDb } from '../db/index.js';
import { contactStatusSql } from '../contacts/repo.js';

/** Neutralizes spreadsheet formula injection (=, +, -, @, tab, CR) per OWASP guidance. */
export function safeCell(v: unknown): string | number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

export interface Column {
  header: string;
  key: string;
  width: number;
}

export async function writeWorkbook(file: string, sheet: string, columns: Column[], rows: Record<string, unknown>[]): Promise<string> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Smart Applytick';
  wb.created = new Date();
  const ws = wb.addWorksheet(sheet, { views: [{ state: 'frozen', ySplit: 1 }] });
  ws.columns = columns.map((c) => ({ header: c.header, key: c.key, width: c.width }));
  for (const r of rows) {
    const out: Record<string, unknown> = {};
    for (const c of columns) out[c.key] = safeCell(r[c.key]);
    ws.addRow(out);
  }
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1D4ED8' } };
  header.alignment = { vertical: 'middle' };
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  await wb.xlsx.writeFile(file);
  return file;
}

export async function exportCompanies(): Promise<string> {
  const rows = getDb()
    .prepare(
      `SELECT co.*, (SELECT COUNT(*) FROM contacts c WHERE c.company_id = co.id) AS contact_count,
              (SELECT GROUP_CONCAT(DISTINCT provider) FROM company_sources s WHERE s.company_id = co.id) AS sources,
              (SELECT GROUP_CONCAT(source_url, ' | ') FROM company_sources s WHERE s.company_id = co.id AND source_url IS NOT NULL) AS source_urls
       FROM companies co ORDER BY co.name`,
    )
    .all() as Record<string, unknown>[];
  return writeWorkbook(path.join(config().dataDir, 'companies.xlsx'), 'Companies', [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Company', key: 'name', width: 36 },
    { header: 'Website', key: 'website_url', width: 36 },
    { header: 'Domain', key: 'domain', width: 26 },
    { header: 'Industry', key: 'industry', width: 22 },
    { header: 'City', key: 'city', width: 16 },
    { header: 'State', key: 'state', width: 16 },
    { header: 'Country', key: 'country', width: 14 },
    { header: 'Address', key: 'address', width: 40 },
    { header: 'Contacts', key: 'contact_count', width: 10 },
    { header: 'Status', key: 'discovery_status', width: 16 },
    { header: 'Pages scanned', key: 'pages_scanned', width: 14 },
    { header: 'Last scan', key: 'last_scanned_at', width: 22 },
    { header: 'Scan notes', key: 'scan_error', width: 50 },
    { header: 'Source', key: 'sources', width: 14 },
    { header: 'Source URL', key: 'source_urls', width: 44 },
  ], rows);
}

export async function exportContacts(ids?: number[]): Promise<string> {
  const st = contactStatusSql();
  const where = ids?.length ? `WHERE c.id IN (${ids.map(() => '?').join(',')})` : '';
  const rows = getDb()
    .prepare(
      `SELECT c.*, co.name AS company_name, co.website_url, co.city, co.state, co.country, ${st.sql} AS eligibility,
              (SELECT GROUP_CONCAT(source_url, ' | ') FROM (SELECT DISTINCT source_url FROM contact_evidence e WHERE e.contact_id = c.id)) AS sources
       FROM contacts c JOIN companies co ON co.id = c.company_id LEFT JOIN suppressions s ON s.email = c.email
       ${where} ORDER BY co.name, c.email`,
    )
    .all(...st.params, ...(ids ?? [])) as Record<string, unknown>[];
  for (const r of rows) {
    r.mx = r.mx_checked ? (r.mx_valid ? 'MX found' : 'No MX') : 'Not checked';
    r.explanation = (JSON.parse(String(r.confidence_explanation)) as string[]).join('; ');
  }
  return writeWorkbook(path.join(config().dataDir, 'contacts.xlsx'), 'Contacts', [
    { header: 'ID', key: 'id', width: 8 },
    { header: 'Email', key: 'email', width: 34 },
    { header: 'Name', key: 'name', width: 22 },
    { header: 'Role (as displayed)', key: 'role_title', width: 22 },
    { header: 'Type', key: 'contact_type', width: 18 },
    { header: 'Company', key: 'company_name', width: 32 },
    { header: 'Website', key: 'website_url', width: 30 },
    { header: 'City', key: 'city', width: 14 },
    { header: 'State', key: 'state', width: 14 },
    { header: 'Country', key: 'country', width: 12 },
    { header: 'Confidence', key: 'confidence', width: 11 },
    { header: 'Eligibility', key: 'eligibility', width: 15 },
    { header: 'Domain matches site', key: 'domain_matches_company', width: 12 },
    { header: 'MX check', key: 'mx', width: 12 },
    { header: 'Source pages', key: 'sources', width: 60 },
    { header: 'Confidence explanation', key: 'explanation', width: 80 },
    { header: 'First seen', key: 'first_seen_at', width: 22 },
  ], rows);
}

export async function exportCampaignHistory(): Promise<string> {
  const rows = getDb()
    .prepare(
      `SELECT m.*, c.name AS campaign_name, c.test_mode FROM campaign_messages m JOIN campaigns c ON c.id = m.campaign_id
       ORDER BY m.campaign_id DESC, m.id`,
    )
    .all() as Record<string, unknown>[];
  for (const r of rows) r.mode = r.test_mode ? 'Test' : 'Live';
  return writeWorkbook(path.join(config().dataDir, 'campaign-history.xlsx'), 'Campaign history', [
    { header: 'Campaign', key: 'campaign_name', width: 28 },
    { header: 'Mode', key: 'mode', width: 8 },
    { header: 'Message ID', key: 'id', width: 10 },
    { header: 'Recipient', key: 'email', width: 34 },
    { header: 'Name', key: 'recipient_name', width: 22 },
    { header: 'Company', key: 'company_name', width: 30 },
    { header: 'Subject', key: 'subject', width: 44 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Attempts', key: 'attempts', width: 9 },
    { header: 'Error code', key: 'error_code', width: 14 },
    { header: 'Error / note', key: 'error_message', width: 60 },
    { header: 'SMTP response', key: 'smtp_response', width: 40 },
    { header: 'Submitted at', key: 'submit_started_at', width: 22 },
    { header: 'Processed at', key: 'processed_at', width: 22 },
    { header: 'Delivered at', key: 'delivered_at', width: 22 },
  ], rows);
}
