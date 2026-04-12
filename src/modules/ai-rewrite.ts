/* ═══════════════════════════════════════════════════════════════════════
   NoteFlow — ai-rewrite.ts
   AI-powered rewrite of note disclosure text to SEC 10-K quality
   ═══════════════════════════════════════════════════════════════════════ */

import { meta } from './utils';

// Field context for better AI prompts
const FIELD_CONTEXT: Record<string, string> = {
  'nq-business-desc': 'Nature of Operations — describe what the company does, its principal products/services, and markets served',
  'nq-revenue-recognition': 'Revenue Recognition policy under ASC 606 — describe performance obligations, timing of recognition, and significant judgments',
  'nq-cash-equiv': 'Cash and Cash Equivalents policy — define what qualifies as cash equivalents and any restrictions',
  'nq-allowance-text': 'Allowance for Doubtful Accounts — describe methodology for estimating credit losses under ASC 326 (CECL)',
  'nq-intangibles-text': 'Intangible Assets policy — describe amortization methods, useful lives, and impairment testing approach',
  'nq-tax-uncertain-text': 'Uncertain Tax Positions — describe evaluation methodology and any material positions under ASC 740-10',
  'nq-debt-text': 'Debt and Notes Payable — describe terms, interest rates, maturity dates, covenants, and collateral',
  'nq-loc-text': 'Lines of Credit — describe facility terms, available capacity, interest rate, and expiration',
  'nq-leases-text': 'Leases under ASC 842 — describe lease arrangements, terms, renewal options, and discount rate methodology',
  'nq-equity-text': 'Stockholders Equity — describe classes of stock, authorized/issued/outstanding shares, par value, and any preferences',
  'nq-distributions-text': 'Distributions/Dividends — describe dividend policy, amounts declared and paid during the period',
  'nq-related-text': 'Related Party Transactions under ASC 850 — describe nature of relationship, transactions, and amounts',
  'nq-cust-conc-text': 'Customer Revenue Concentration — identify significant customers and percentage of total revenue',
  'nq-vendor-conc-text': 'Vendor/Supplier Concentration — identify significant suppliers and percentage of purchases',
  'nq-litigation-text': 'Litigation and Legal Proceedings under ASC 450 — describe pending/threatened claims and estimated exposure',
  'nq-other-commit-text': 'Other Commitments and Contractual Obligations under ASC 440 — describe purchase commitments, guarantees, etc.',
  'nq-subseq-text': 'Subsequent Events under ASC 855 — describe material events after balance sheet date requiring disclosure',
  'nq-gc-text': 'Going Concern under ASC 205-40 — describe conditions raising substantial doubt and management plans to mitigate',
};

/**
 * Rewrites user text in professional SEC 10-K disclosure language using the Anthropic API.
 */
export async function aiRewrite(targetId: string): Promise<void> {
  const textarea = document.getElementById(targetId) as HTMLTextAreaElement | null;
  if (!textarea) return;

  const userText = textarea.value.trim();
  if (!userText) {
    alert('Please enter some text first, then click AI Rewrite to enhance it.');
    return;
  }

  // Find the button and show loading state
  const btn = document.querySelector(`[data-target="${targetId}"]`) as HTMLButtonElement | null;
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = '<span class="ai-spinner"></span> Rewriting...';
  }

  const m = meta();
  const context = FIELD_CONTEXT[targetId] || 'financial statement note disclosure';

  try {
    // Get the API key from localStorage or prompt
    let apiKey = localStorage.getItem('noteflow-ai-key');
    if (!apiKey) {
      apiKey = prompt('Enter your Anthropic API key to enable AI Rewrite.\nYour key is stored locally and never sent to NoteFlow servers.');
      if (!apiKey) {
        if (btn) { btn.disabled = false; btn.innerHTML = '✨ AI Rewrite'; }
        return;
      }
      localStorage.setItem('noteflow-ai-key', apiKey);
    }

    const systemPrompt = `You are an expert CPA and SEC financial reporting specialist. Rewrite the user's draft text into professional financial statement note disclosure language suitable for an SEC 10-K filing or audited financial statements prepared under U.S. GAAP.

Rules:
- Write in third person, referring to the entity as "the Company"
- Use formal, precise accounting language consistent with ASC codification
- Maintain all factual details from the user's input — do not add fictional numbers or make up facts
- Include relevant ASC references where appropriate (e.g., "in accordance with ASC 606")
- Keep paragraphs concise but thorough
- Do not include note headers or numbers — just the body text
- The company name is: ${m.company || 'the Company'}
- The reporting period is: ${m.period || 'the current period'}
- This field is for: ${context}`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          { role: 'user', content: `Rewrite this draft disclosure text in professional SEC 10-K note language:\n\n${userText}` }
        ],
        system: systemPrompt,
      }),
    });

    if (!response.ok) {
      const errData = await response.json().catch(() => ({}));
      if (response.status === 401) {
        localStorage.removeItem('noteflow-ai-key');
        throw new Error('Invalid API key. Please try again.');
      }
      throw new Error(errData.error?.message || `API error: ${response.status}`);
    }

    const data = await response.json();
    const rewrittenText = data.content?.[0]?.text || '';

    if (rewrittenText) {
      // Store original for undo
      textarea.dataset.originalText = userText;
      textarea.value = rewrittenText;
      // Trigger input event so any listeners pick up the change
      textarea.dispatchEvent(new Event('input', { bubbles: true }));

      if (btn) {
        btn.innerHTML = '↩ Undo Rewrite';
        btn.disabled = false;
        btn.onclick = function() {
          textarea.value = textarea.dataset.originalText || userText;
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          btn.innerHTML = '✨ AI Rewrite';
          btn.onclick = null;
        };
        return; // Don't reset button below
      }
    }
  } catch (err: any) {
    alert('AI Rewrite failed: ' + err.message);
  }

  if (btn) {
    btn.disabled = false;
    btn.innerHTML = '✨ AI Rewrite';
  }
}
