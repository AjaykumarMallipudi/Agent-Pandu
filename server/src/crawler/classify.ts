import { emailDomainMatchesCompany } from '../lib/url.js';
import type { ExtractionMethod, PageType } from './extract.js';
import { isValidEmailSyntax } from './extract.js';

export const CONTACT_TYPES = [
  'HR',
  'Recruiter',
  'Recruitment',
  'Talent Acquisition',
  'Careers',
  'Hiring',
  'General Contact',
  'Founder',
  'CEO',
  'Other',
] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export interface EvidenceInput {
  sourceUrl: string;
  pageType: PageType;
  method: ExtractionMethod;
  context: string;
  heading?: string | null;
}

export interface ContactFacts {
  email: string;
  companyDomain: string | null;
  evidence: EvidenceInput[];
  mx: { checked: boolean; valid: boolean | null };
}

export interface Classification {
  contactType: ContactType;
  name: string | null;
  roleTitle: string | null;
  syntaxValid: boolean;
  domainMatchesCompany: boolean;
  confidence: number;
  explanation: string[];
}

const LOCAL_RULES: [RegExp, ContactType][] = [
  [/talent/, 'Talent Acquisition'],
  [/recruiter/, 'Recruiter'],
  [/recruit/, 'Recruitment'],
  [/^(hr|humanresources|human[._-]resources|people|peopleops|people[._-]ops)$|^hr[._-]|[._-]hr$/, 'HR'],
  [/careers?/, 'Careers'],
  [/^(jobs?|hiring|hire|resumes?|cv|apply)$|^(jobs?|hiring)[._-]/, 'Hiring'],
  [/^ceo$|^ceo[._-]/, 'CEO'],
  [/^founders?$|^founder[._-]|^cofounder/, 'Founder'],
  [/^(info|contact|contactus|hello|hi|enquiry|enquiries|inquiry|inquiries|office|mail|team|business|connect|reachus|general)$/, 'General Contact'],
];

const CONTEXT_RULES: [RegExp, ContactType][] = [
  [/talent acquisition/i, 'Talent Acquisition'],
  [/\brecruiter\b/i, 'Recruiter'],
  [/\brecruit(ment|ing)\b/i, 'Recruitment'],
  [/\b(HR|human resources?|people (team|operations))\b/, 'HR'],
  [/\b(send|email|mail|share|submit)\b[^.]{0,40}\b(resume|cv|résumé|application)s?\b/i, 'Hiring'],
  [/\b(careers?|job openings?|current openings|join (our|the) team)\b/i, 'Careers'],
];

const ROLE_RE =
  /(Chief Executive Officer|CEO|Co-?\s?Founder(?:\s*(?:&|and)\s*CEO)?|Founder(?:\s*(?:&|and)\s*CEO)?|Managing Director|HR Manager|HR Executive|HR Head|Head of (?:HR|People|Talent(?: Acquisition)?)|Human Resources(?: Manager| Executive)?|Talent Acquisition(?: Specialist| Lead| Manager| Partner)?|Recruiter|Recruitment (?:Manager|Lead|Specialist)|People Operations)/;
const NAME_RE = /((?:Dr\.?\s|Mr\.?\s|Ms\.?\s|Mrs\.?\s)?[A-Z][a-z]+(?:\s[A-Z]\.)?(?:\s[A-Z][a-z'’-]+){1,2})/;
const NAME_STOPWORDS =
  /\b(Contact|Our|Team|Office|Head|Human|Resources|Get|Touch|Email|Call|Us|About|Careers?|Jobs?|Join|Company|Services|Solutions|Technologies|Private|Limited|Pvt|Ltd|Inc|LLP|Address|Phone|Mail|Write|Reach|Send|Apply|Hiring|Talent|Acquisition|Founder|Chief|Executive|Officer|Managing|Director|Recruitment|Recruiter|Sales|Support|The|And|For)\b/;

/** Finds an explicitly displayed "Name, Role" or "Role: Name" pairing. Returns nothing without such evidence. */
export function extractNameAndRole(context: string): { name: string | null; roleTitle: string | null } {
  const sep = String.raw`\s*(?:,|–|—|-|\||:|\(|\n)\s*`;
  const a = new RegExp(NAME_RE.source + sep + ROLE_RE.source).exec(context);
  const b = a ? null : new RegExp(ROLE_RE.source + sep + NAME_RE.source).exec(context);
  const name = a ? a[1] : b ? b[2] : undefined;
  const role = a ? a[2] : b ? b[1] : undefined;
  if (name && !NAME_STOPWORDS.test(name)) return { name: name.trim(), roleTitle: role?.trim() ?? null };
  const roleOnly = ROLE_RE.exec(context);
  return { name: null, roleTitle: roleOnly ? roleOnly[1]!.trim() : null };
}

function roleToType(role: string): ContactType | null {
  if (/CEO|Chief Executive/i.test(role) && !/Founder/i.test(role)) return 'CEO';
  if (/Founder/i.test(role)) return 'Founder';
  if (/Talent/i.test(role)) return 'Talent Acquisition';
  if (/Recruiter/i.test(role)) return 'Recruiter';
  if (/Recruitment/i.test(role)) return 'Recruitment';
  if (/HR|Human Resources|People/i.test(role)) return 'HR';
  return null;
}

/** Pure, evidence-based classification and confidence scoring. */
export function classifyContact(facts: ContactFacts): Classification {
  const explanation: string[] = [];
  const email = facts.email.toLowerCase();
  const [local = '', domain = ''] = email.split('@');
  const syntaxValid = isValidEmailSyntax(email);
  if (!syntaxValid) {
    return {
      contactType: 'Other', name: null, roleTitle: null, syntaxValid, domainMatchesCompany: false, confidence: 0,
      explanation: ['Invalid email syntax'],
    };
  }
  explanation.push('Syntax valid (format only — not a deliverability check)');

  let score = 10;
  const methods = new Set(facts.evidence.map((e) => e.method));
  if (methods.has('mailto')) {
    score += 25;
    explanation.push('+25 published as a mailto link');
  } else if (methods.has('text')) {
    score += 15;
    explanation.push('+15 displayed as visible page text');
  }

  const domainMatchesCompany = facts.companyDomain ? emailDomainMatchesCompany(domain, facts.companyDomain) : false;
  if (domainMatchesCompany) {
    score += 25;
    explanation.push(`+25 email domain matches company website (${facts.companyDomain})`);
  } else {
    score -= 15;
    explanation.push(`-15 email domain ${domain} differs from company website ${facts.companyDomain ?? '(none)'}`);
  }

  const pages = new Set(facts.evidence.map((e) => e.sourceUrl));
  const pageTypes = new Set(facts.evidence.map((e) => e.pageType));
  if (['contact', 'careers', 'team', 'leadership'].some((t) => pageTypes.has(t as PageType))) {
    score += 10;
    explanation.push(`+10 found on a ${[...pageTypes].filter((t) => t !== 'home' && t !== 'other').join('/')} page`);
  }
  if (pages.size > 1) {
    const bonus = Math.min(10, (pages.size - 1) * 5);
    score += bonus;
    explanation.push(`+${bonus} seen on ${pages.size} pages`);
  }

  // Type: local-part evidence first, then explicit role/name evidence, then nearby text.
  let contactType: ContactType = 'Other';
  let typeEvidence: string | null = null;
  for (const [re, t] of LOCAL_RULES) {
    if (re.test(local)) {
      contactType = t;
      typeEvidence = `address name "${local}" indicates ${t}`;
      score += t === 'General Contact' ? 5 : 15;
      break;
    }
  }

  let name: string | null = null;
  let roleTitle: string | null = null;
  for (const ev of facts.evidence) {
    const r = extractNameAndRole(ev.context);
    if (r.name && !name) name = r.name;
    if (r.roleTitle && !roleTitle) roleTitle = r.roleTitle;
  }
  if (name) {
    // Attach a displayed name only when the address itself belongs to that person (first or last name in it).
    // A shared inbox or unrelated address listed near a person is not that person's address.
    const parts = name.replace(/^(Dr|Mr|Ms|Mrs)\.?\s/, '').toLowerCase().split(/\s+/).filter((p) => p.length >= 3);
    if (parts.some((p) => local.includes(p.replace(/[^a-z]/g, '')))) {
      score += 5;
      explanation.push(`+5 displayed name "${name}" matches address`);
    } else {
      name = null;
      roleTitle = null;
    }
  }

  if (contactType === 'Other') {
    const roleType = roleTitle && name ? roleToType(roleTitle) : null;
    if (roleType) {
      contactType = roleType;
      typeEvidence = `page shows "${name}, ${roleTitle}" next to this address`;
      score += 10;
    } else {
      for (const ev of facts.evidence) {
        const hay = `${ev.heading ?? ''} ${ev.context}`;
        const hit = CONTEXT_RULES.find(([re]) => re.test(hay));
        if (hit) {
          contactType = hit[1];
          typeEvidence = `nearby text mentions ${hit[1]}`;
          score += 10;
          break;
        }
      }
      if (contactType === 'Other' && pageTypes.has('careers')) {
        contactType = 'Careers';
        typeEvidence = 'listed on the careers page';
        score += 5;
      }
    }
  }
  if (typeEvidence) explanation.push(`Type ${contactType}: ${typeEvidence}`);
  else explanation.push('Type Other: no role evidence found');

  if (facts.mx.checked) {
    if (facts.mx.valid) {
      score += 10;
      explanation.push('+10 domain has MX records (DNS check performed)');
    } else {
      score = Math.min(score, 10);
      explanation.push('Domain has no MX records — likely undeliverable');
    }
  } else {
    explanation.push('MX not checked');
  }
  explanation.push('No mailbox-level verification performed');

  return {
    contactType,
    name,
    roleTitle,
    syntaxValid,
    domainMatchesCompany,
    confidence: Math.max(0, Math.min(100, score)),
    explanation,
  };
}
