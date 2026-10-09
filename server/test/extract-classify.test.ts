import { describe, expect, it } from 'vitest';
import { classifyContact, extractNameAndRole, type EvidenceInput } from '../src/crawler/classify.js';
import { classifyPage, extractCandidateLinks, extractEmails, isValidEmailSyntax } from '../src/crawler/extract.js';

describe('email extraction', () => {
  it('extracts mailto links and visible text, normalized and de-duplicated', () => {
    const found = extractEmails(`<body>
      <h2>Human Resources</h2>
      <p>Reach our HR team at <a href="mailto:HR@Acme.com?subject=Hi">hr@acme.com</a></p>
      <footer><p>General enquiries: info@acme.com</p></footer>
      <a href="mailto:a@acme.com,b@acme.com">two</a>
    </body>`);
    const byEmail = Object.fromEntries(found.map((f) => [`${f.email}|${f.method}`, f]));
    expect(Object.keys(byEmail).sort()).toEqual(
      ['a@acme.com|mailto', 'b@acme.com|mailto', 'hr@acme.com|mailto', 'info@acme.com|text'].sort(),
    );
    expect(byEmail['hr@acme.com|mailto']!.context).toContain('Reach our HR team');
    expect(byEmail['hr@acme.com|mailto']!.heading).toBe('Human Resources');
  });

  it('ignores scripts, assets, placeholders and no-reply addresses', () => {
    const found = extractEmails(`<body>
      <script>var e = "hidden@acme.com";</script>
      <img src="logo@2x.png"> logo@2x.png
      <p>you@example.com noreply@acme.com 1a2b@sentry.io name@domain.com</p>
    </body>`);
    expect(found).toEqual([]);
  });

  it('does not de-obfuscate or guess addresses', () => {
    const found = extractEmails('<body><p>jobs [at] acme [dot] com</p><p>Contact John Smith</p></body>');
    expect(found).toEqual([]);
  });

  it('validates syntax strictly', () => {
    expect(isValidEmailSyntax('a.b+c@sub.acme.co.in')).toBe(true);
    for (const bad of ['a..b@acme.com', '.a@acme.com', 'a@acme', 'a@-acme.com', 'a@acme.c0m', `${'x'.repeat(65)}@acme.com`]) {
      expect(isValidEmailSyntax(bad), bad).toBe(false);
    }
  });

  it('finds candidate links in priority order and classifies pages', () => {
    const links = extractCandidateLinks(
      '<a href="/about-us">About</a><a href="/contact">Contact</a><a href="/jobs">Jobs</a><a href="/blog">Blog</a><a href="https://x.org/contact">x</a>',
      'https://acme.com/',
      'acme.com',
    );
    expect(links.map((l) => new URL(l.url).pathname)).toEqual(['/contact', '/jobs', '/about-us']);
    expect(classifyPage('https://acme.com/')).toBe('home');
    expect(classifyPage('https://acme.com/careers')).toBe('careers');
    expect(classifyPage('https://acme.com/leadership-team')).toBe('leadership');
  });
});

const ev = (context: string, extra: Partial<EvidenceInput> = {}): EvidenceInput => ({
  sourceUrl: 'https://acme.com/contact',
  pageType: 'contact',
  method: 'mailto',
  context,
  ...extra,
});
const facts = (email: string, evidence: EvidenceInput[], mx = { checked: false, valid: null as boolean | null }) => ({
  email,
  companyDomain: 'acme.com',
  evidence,
  mx,
});

describe('contact classification', () => {
  it('classifies by address evidence', () => {
    const cases: [string, string][] = [
      ['hr@acme.com', 'HR'],
      ['careers@acme.com', 'Careers'],
      ['jobs@acme.com', 'Hiring'],
      ['talent.acquisition@acme.com', 'Talent Acquisition'],
      ['recruiter@acme.com', 'Recruiter'],
      ['recruitment@acme.com', 'Recruitment'],
      ['info@acme.com', 'General Contact'],
      ['ceo@acme.com', 'CEO'],
      ['founder@acme.com', 'Founder'],
      ['sales@acme.com', 'Other'],
    ];
    for (const [email, type] of cases) expect(classifyContact(facts(email, [ev('Contact us')])).contactType, email).toBe(type);
  });

  it('uses nearby text when the address itself is not descriptive', () => {
    const c = classifyContact(facts('priya@acme.com', [ev('For talent acquisition queries write to priya@acme.com')]));
    expect(c.contactType).toBe('Talent Acquisition');
    expect(c.explanation.join(' ')).toMatch(/nearby text/);
  });

  it('identifies a founder only with explicit name + role evidence matching the address', () => {
    const c = classifyContact(facts('rahul.mehta@acme.com', [ev('Rahul Mehta, Co-Founder & CEO — rahul.mehta@acme.com', { pageType: 'leadership' })]));
    expect(c.contactType).toBe('Founder');
    expect(c.name).toBe('Rahul Mehta');
    expect(c.roleTitle).toMatch(/Founder/);
  });

  it('never attaches a nearby person to an unrelated or shared address', () => {
    const shared = classifyContact(facts('sales@acme.com', [ev('Rahul Mehta, CEO. Sales: sales@acme.com')]));
    expect(shared.contactType).toBe('Other');
    expect(shared.name).toBeNull();
    const inbox = classifyContact(facts('info@acme.com', [ev('Anita Rao, Founder. Write to info@acme.com')]));
    expect(inbox.contactType).toBe('General Contact');
    expect(inbox.name).toBeNull();
  });

  it('never treats syntax validity as verification', () => {
    const c = classifyContact(facts('hr@acme.com', [ev('HR')]));
    expect(c.syntaxValid).toBe(true);
    expect(c.explanation).toContain('No mailbox-level verification performed');
    expect(c.explanation).toContain('MX not checked');
    expect(c.explanation.some((e) => /verified/i.test(e) && !/no mailbox/i.test(e))).toBe(false);
  });

  it('scores evidence and penalizes foreign domains and missing MX', () => {
    const strong = classifyContact(facts('hr@acme.com', [ev('HR'), ev('HR', { sourceUrl: 'https://acme.com/careers', pageType: 'careers' })], { checked: true, valid: true }));
    const foreign = classifyContact({ ...facts('acme.hr@gmail.com', [ev('HR', { method: 'text', pageType: 'home' })]) });
    const noMx = classifyContact(facts('hr@acme.com', [ev('HR')], { checked: true, valid: false }));
    expect(strong.confidence).toBeGreaterThan(80);
    expect(foreign.confidence).toBeLessThan(40);
    expect(foreign.domainMatchesCompany).toBe(false);
    expect(noMx.confidence).toBeLessThanOrEqual(10);
  });

  it('extracts name/role pairs only from explicit patterns', () => {
    expect(extractNameAndRole('Meera Iyer | Head of Talent Acquisition')).toEqual({ name: 'Meera Iyer', roleTitle: 'Head of Talent Acquisition' });
    expect(extractNameAndRole('Contact Us, Founder')).toEqual({ name: null, roleTitle: 'Founder' });
    expect(extractNameAndRole('We are hiring')).toEqual({ name: null, roleTitle: null });
  });
});
