/**
 * engine/compliance-pages.js — renders the subprocessor page from
 * compliance/subprocessors.json (the single source of truth) so the HTML page,
 * the JSON endpoint and the DPA can never drift apart.
 */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * Entries still carrying an unconfirmed `operatorConfirm` field are flagged on
 * the page rather than silently presenting unverified terms as fact.
 */
export function renderSubprocessorRows(subs) {
  return (subs.subprocessors ?? []).map((s) => {
    const unconfirmed = (s.operatorConfirm ?? []).filter((f) => !s.confirmed?.[f]);
    const name = s.url ? `<a href="${esc(s.url)}" rel="noopener noreferrer">${esc(s.name)}</a>` : esc(s.name);
    const tag = `<span class="tag">${s.use === 'optional' ? 'optional' : 'always'}</span>`;
    const note = unconfirmed.length ? '<br><em>Provider retention terms: being confirmed.</em>' : '';
    return `<tr><td><strong>${name}</strong><br>${tag}</td>`
      + `<td>${esc(s.purpose)}<br><strong>Data:</strong> ${esc(s.data)}<br><strong>Provider retention:</strong> ${esc(s.providerRetention)}${note}</td>`
      + `<td>${esc(s.location)}</td><td>${esc(s.usedWhen)}</td></tr>`;
  }).join('\n');
}

/** Fill the {{SUBPROCESSOR_*}} placeholders in landing/subprocessors.html. */
export function renderSubprocessorsPage(html, subs) {
  const items = subs.customerDirectedIntegrations?.items ?? [];
  return html
    .replaceAll('{{SUBPROCESSORS_UPDATED}}', esc(subs.lastUpdated))
    .replaceAll('{{SUBPROCESSORS_NOTICE}}', esc(subs.noticePeriodDays))
    .replace('{{SUBPROCESSOR_ROWS}}', () => renderSubprocessorRows(subs))
    .replace('{{CUSTOMER_DIRECTED}}', () => esc(items.join(', ') || 'Git hosting providers'));
}

/** JSON served at /subprocessors.json: drop internal fields. */
export function publicSubprocessors(subs) {
  return {
    lastUpdated: subs.lastUpdated,
    noticePeriodDays: subs.noticePeriodDays,
    subprocessors: (subs.subprocessors ?? []).map(({ operatorConfirm, confirmed, ...rest }) => rest), // eslint-disable-line no-unused-vars
    customerDirectedIntegrations: subs.customerDirectedIntegrations?.items ?? [],
  };
}
