/* ===================================================================
   NoteFlow — research.ts
   Company research, auto-fill from Wikipedia/SEC/DuckDuckGo
   =================================================================== */

import { esc, el, elInput } from './utils';
import { saveProject } from './data';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ResearchFindings {
  name: string;
  description: string | null;
  entityType: string | null;
  state: string | null;
  formed: string | null;
  industry: string | null;
  sic: string | null;
  ticker: string | null;
  isPublic: boolean;
  address: string | null;
  sources: { name: string; url: string }[];
}

interface ResearchFindingItem {
  label: string;
  value: string | null;
  fieldId: string | null;
  fieldType: string;
  applyValue: string | null;
}

// ---------------------------------------------------------------------------
// State abbreviation map (reused across functions)
// ---------------------------------------------------------------------------

const STATE_MAP: Record<string, string> = {
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California',
  CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware', FL: 'Florida', GA: 'Georgia',
  HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland',
  MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota', MS: 'Mississippi', MO: 'Missouri',
  MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio',
  OK: 'Oklahoma', OR: 'Oregon', PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina',
  SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah', VT: 'Vermont',
  VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  DC: 'District of Columbia',
};

// ---------------------------------------------------------------------------
// Research engine
// ---------------------------------------------------------------------------

export function researchCompany(): void {
  const nameInput = elInput('companyName');
  if (!nameInput) return;
  const name: string = (nameInput.value || '').trim();
  if (!name) { alert('Please enter a company name first.'); return; }

  const btn = el('research-btn') as HTMLButtonElement | null;
  const btnText = el('research-btn-text');
  if (!btn || !btnText) return;
  btn.disabled = true;
  btnText.innerHTML = '<span class="spinner"></span> Searching...';

  const findings: ResearchFindings = {
    name: name,
    description: null,
    entityType: null,
    state: null,
    formed: null,
    industry: null,
    sic: null,
    ticker: null,
    isPublic: false,
    address: null,
    sources: [],
  };

  // 1. Parse entity type from name suffix
  const nameEntityMap: { pattern: RegExp; type: string }[] = [
    { pattern: /\bLLC\b|\bL\.L\.C\.\b/i, type: 'Limited Liability Company (LLC)' },
    { pattern: /\bLLP\b|\bL\.L\.P\.\b/i, type: 'Partnership' },
    { pattern: /\bLP\b|\bL\.P\.\b/i, type: 'Partnership' },
    { pattern: /\bInc\.?\b|\bIncorporated\b/i, type: 'C Corporation' },
    { pattern: /\bCorp\.?\b|\bCorporation\b/i, type: 'C Corporation' },
    { pattern: /\bCo\.?\b|\bCompany\b/i, type: 'C Corporation' },
    { pattern: /\bPLC\b/i, type: 'C Corporation' },
    { pattern: /\bFoundation\b|\b501\(c\)/i, type: 'Nonprofit Organization' },
  ];
  nameEntityMap.forEach(function (m) {
    if (m.pattern.test(name) && !findings.entityType) findings.entityType = m.type;
  });

  // 2. Launch parallel API searches
  const searchName: string = encodeURIComponent(name);
  const promises: Promise<any>[] = [];

  // A. OpenCorporates — company registration data
  promises.push(
    fetch('https://api.opencorporates.com/v0.4/companies/search?q=' + searchName + '&jurisdiction_code=us&per_page=5')
      .then(function (r) { return r.json(); })
      .then(function (data: any) {
        if (data.results && data.results.companies && data.results.companies.length > 0) {
          const co = data.results.companies[0].company;
          findings.sources.push({ name: 'OpenCorporates', url: co.opencorporates_url || 'https://opencorporates.com' });
          if (co.incorporation_date) findings.formed = formatResearchDate(co.incorporation_date);
          if (co.jurisdiction_code) {
            const jur: string = co.jurisdiction_code.replace('us_', '').toUpperCase();
            if (STATE_MAP[jur]) findings.state = STATE_MAP[jur];
          }
          // Refine entity type from company_type
          if (co.company_type) {
            const ct: string = co.company_type.toLowerCase();
            if (ct.indexOf('llc') >= 0 || ct.indexOf('limited liability') >= 0) findings.entityType = 'Limited Liability Company (LLC)';
            else if (ct.indexOf('nonprofit') >= 0 || ct.indexOf('not-for-profit') >= 0) findings.entityType = 'Nonprofit Organization';
            else if (ct.indexOf('partnership') >= 0 || ct.indexOf('lp') >= 0) findings.entityType = 'Partnership';
            else if (ct.indexOf('corporation') >= 0 || ct.indexOf('inc') >= 0) findings.entityType = 'C Corporation';
          }
          if (co.registered_address) {
            const addr = co.registered_address;
            const parts: string[] = [addr.street_address, addr.locality, addr.region, addr.postal_code].filter(Boolean);
            if (parts.length > 0) findings.address = parts.join(', ');
          }
        }
      })
      .catch(function () { /* OpenCorporates unavailable */ })
  );

  // B. Wikipedia — business description (try full name, then stripped name)
  promises.push(
    fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(name))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data: any) {
        if (data && data.extract && data.type === 'standard' && isCompanyArticle(data.extract, name)) {
          findings.description = data.extract;
          findings.sources.push({ name: 'Wikipedia', url: data.content_urls ? data.content_urls.desktop.page : 'https://en.wikipedia.org' });
        } else {
          // Try with suffix stripped
          const stripped: string = name.replace(/,?\s*(Inc|LLC|Corp|Corporation|Ltd|Co|LP|LLP|Company)\.?\s*$/i, '').trim();
          if (stripped !== name) {
            return fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(stripped))
              .then(function (r2) { return r2.ok ? r2.json() : null; })
              .then(function (data2: any) {
                if (data2 && data2.extract && data2.type === 'standard' && isCompanyArticle(data2.extract, stripped)) {
                  findings.description = data2.extract;
                  findings.sources.push({ name: 'Wikipedia', url: data2.content_urls ? data2.content_urls.desktop.page : 'https://en.wikipedia.org' });
                }
              });
          }
          // Also try with "(company)" disambiguation
          return fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(stripped + ' (company)'))
            .then(function (r3) { return r3.ok ? r3.json() : null; })
            .then(function (data3: any) {
              if (!findings.description && data3 && data3.extract && data3.type === 'standard') {
                findings.description = data3.extract;
                findings.sources.push({ name: 'Wikipedia', url: data3.content_urls ? data3.content_urls.desktop.page : 'https://en.wikipedia.org' });
              }
            });
        }
      })
      .catch(function () { /* Wikipedia unavailable */ })
  );

  // C. SEC EDGAR — public company data (SIC, ticker, address)
  promises.push(
    fetch('https://efts.sec.gov/LATEST/search-index?q=' + searchName + '&dateRange=custom&startdt=2020-01-01&forms=10-K&from=0&size=1', { headers: { 'User-Agent': 'NoteFlow/1.0' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data: any) {
        if (data && data.hits && data.hits.hits && data.hits.hits.length > 0) {
          const hit = data.hits.hits[0]._source;
          findings.isPublic = true;
          if (hit.display_names && hit.display_names.length > 0) {
            findings.sources.push({ name: 'SEC EDGAR', url: 'https://www.sec.gov/cgi-bin/browse-edgar?company=' + searchName + '&CIK=&type=10-K&dateb=&owner=include&count=10&search_text=&action=getcompany' });
          }
        }
      })
      .catch(function () { /* SEC unavailable */ })
  );

  // D. SEC EDGAR full-text company search (CIK lookup)
  promises.push(
    fetch('https://efts.sec.gov/LATEST/search-index?q=%22' + searchName + '%22&forms=10-K', { headers: { 'User-Agent': 'NoteFlow/1.0' } })
      .catch(function () { return null; })
  );

  // E. DuckDuckGo Instant Answer — general company info
  promises.push(
    fetch('https://api.duckduckgo.com/?q=' + searchName + '&format=json&no_redirect=1&no_html=1')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data: any) {
        if (data) {
          if (data.Abstract && data.Abstract.length > 30) {
            const ddgIsCompany: boolean = isCompanyArticle(data.Abstract, name);
            // Use DDG if no description yet, or if DDG is company-relevant and current isn't
            if (!findings.description || (ddgIsCompany && !isCompanyArticle(findings.description, name))) {
              findings.description = data.Abstract;
              // Remove old Wikipedia source if being replaced
              findings.sources = findings.sources.filter(function (s) { return s.name !== 'Wikipedia' || ddgIsCompany === false; });
              findings.sources.push({ name: 'DuckDuckGo', url: data.AbstractURL || 'https://duckduckgo.com/?q=' + searchName });
            }
          }
          // Extract industry from related topics
          if (data.Infobox && data.Infobox.content) {
            data.Infobox.content.forEach(function (item: any) {
              if (item.label && /industry|sector|type/i.test(item.label)) {
                findings.industry = item.value;
              }
              if (item.label && /traded as|ticker|stock/i.test(item.label)) {
                findings.ticker = item.value;
                findings.isPublic = true;
              }
              if (item.label && /founded|incorporated/i.test(item.label) && !findings.formed) {
                findings.formed = item.value;
              }
              if (item.label && /headquarters|location/i.test(item.label) && !findings.state) {
                // Try to extract state
                const stateMatch = item.value.match(/,\s*([A-Z]{2})\b/);
                if (stateMatch) {
                  if (STATE_MAP[stateMatch[1]]) findings.state = STATE_MAP[stateMatch[1]];
                }
              }
            });
          }
        }
      })
      .catch(function () { /* DuckDuckGo unavailable */ })
  );

  Promise.allSettled(promises).then(function () {
    btn.disabled = false;
    btnText.textContent = 'Research';
    renderResearchFindings(findings);
  });
}

function isCompanyArticle(extract: string, _name: string): boolean {
  if (!extract) return false;
  const lower: string = extract.toLowerCase();
  const companyKeywords = /\b(company|corporation|inc\b|llc|business|headquartered|founded|ceo|revenue|employees|subsidiary|conglomerate|manufacturer|provider|firm|enterprise|multinational|publicly traded|stock exchange|nasdaq|nyse)\b/i;
  return companyKeywords.test(lower);
}

function formatResearchDate(dateStr: string): string {
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  } catch (e) { return dateStr; }
}

function renderResearchFindings(f: ResearchFindings): void {
  const panel = el('research-panel') as (HTMLElement & { _findings?: ResearchFindingItem[] }) | null;
  const body = el('research-panel-body');
  const title = el('research-panel-title');
  if (!panel || !body || !title) return;
  title.textContent = 'Research Results — ' + f.name;

  const items: ResearchFindingItem[] = [];
  let hasAnyData = false;

  function addFinding(
    label: string,
    value: string | null,
    fieldId: string | null,
    fieldType?: string,
    applyValue?: string | null
  ): void {
    if (value) hasAnyData = true;
    items.push({ label: label, value: value, fieldId: fieldId, fieldType: fieldType || 'text', applyValue: applyValue !== undefined ? applyValue : value });
  }

  addFinding('Business Description', f.description, 'nq-business-desc', 'textarea');
  addFinding('Entity Type', f.entityType, 'nq-entity-type', 'select');
  addFinding('State / Jurisdiction', f.state, 'nq-state', 'text');
  addFinding('Date Formed', f.formed, 'nq-formed', 'text');
  addFinding('Industry', f.industry, null, undefined);
  if (f.isPublic) addFinding('Public Company', (f.ticker || 'Yes') + ' — Note: public companies have additional SEC reporting requirements', null, undefined);
  addFinding('Registered Address', f.address, null, undefined);

  let html = '';

  if (!hasAnyData) {
    html += '<div style="text-align:center;padding:20px;color:var(--muted)">';
    html += '<p style="font-size:0.9rem;margin-bottom:8px">No results found for <strong>' + esc(f.name) + '</strong></p>';
    html += '<p style="font-size:0.82rem">Try entering the full legal name (e.g., "Apple Inc." instead of "Apple"). For private companies, you may need to fill in the notes manually.</p>';
    html += '</div>';
  } else {
    // Count applicable items
    const applyCount: number = items.filter(function (i) { return i.value && i.fieldId; }).length;

    if (applyCount > 0) {
      html += '<div class="research-apply-all">';
      html += '<button class="btn btn-primary btn-sm" data-action="applyAllResearch">Apply All to Notes (' + applyCount + ' fields)</button>';
      html += '<button class="btn btn-ghost btn-sm" data-action="closeResearchPanel">Dismiss</button>';
      html += '</div>';
    }

    items.forEach(function (item, idx) {
      html += '<div class="research-finding">';
      html += '<div class="rf-label">' + item.label + '</div>';
      if (item.value) {
        let displayVal: string = item.value;
        // Truncate long descriptions for display
        if (displayVal.length > 300) displayVal = displayVal.substring(0, 300) + '...';
        html += '<div class="rf-value">' + esc(displayVal) + '</div>';
        if (item.fieldId) {
          html += '<button class="rf-apply" id="rf-apply-' + idx + '" data-action="applyResearchField" data-param="' + idx + '" data-field="' + item.fieldId + '" data-type="' + item.fieldType + '" data-value="' + esc(item.applyValue || '').replace(/"/g, '&quot;') + '">Apply</button>';
        }
      } else {
        html += '<div class="rf-value muted">Not found</div>';
      }
      html += '</div>';
    });

    // Sources
    if (f.sources.length > 0) {
      html += '<div class="research-sources"><strong>Sources:</strong> ';
      html += f.sources.map(function (s) {
        const safeUrl: string = (s.url && /^https?:\/\//i.test(s.url)) ? esc(s.url) : '#';
        return '<a href="' + safeUrl + '" target="_blank" rel="noopener">' + esc(s.name) + '</a>';
      }).join(' · ');
      html += '</div>';
    }
  }

  body.innerHTML = html;
  panel.classList.add('open');

  // Store findings for Apply All
  panel._findings = items;
}

export function applyResearchField(idx: number): void {
  const btn = el('rf-apply-' + idx) as HTMLButtonElement | null;
  if (!btn) return;
  const fieldId = btn.getAttribute('data-field');
  const fieldType = btn.getAttribute('data-type');
  const value = btn.getAttribute('data-value');
  if (!fieldId || !fieldType || !value) return;
  const fieldEl = document.getElementById(fieldId) as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null;
  if (!fieldEl) return;

  if (fieldType === 'select') {
    // Find matching option
    const selectEl = fieldEl as HTMLSelectElement;
    const options: HTMLOptionElement[] = Array.from(selectEl.options);
    let match = options.find(function (o) { return o.value === value; });
    if (match) {
      selectEl.value = match.value;
    } else {
      // Try partial match
      match = options.find(function (o) { return o.value.toLowerCase().indexOf(value.toLowerCase()) >= 0 || value.toLowerCase().indexOf(o.value.toLowerCase()) >= 0; });
      if (match) selectEl.value = match.value;
    }
  } else {
    (fieldEl as HTMLInputElement | HTMLTextAreaElement).value = value;
  }

  // Trigger save
  fieldEl.dispatchEvent(new Event('input', { bubbles: true }));
  saveProject();

  // Mark as applied
  btn.textContent = 'Applied';
  btn.classList.add('applied');
}

export function applyAllResearch(): void {
  const panel = el('research-panel');
  if (!panel) return;
  const buttons = panel.querySelectorAll('.rf-apply:not(.applied)');
  buttons.forEach(function (btn) {
    const idx: number = parseInt(btn.id.replace('rf-apply-', ''));
    applyResearchField(idx);
  });
}

export function closeResearchPanel(): void {
  el('research-panel')?.classList.remove('open');
}
