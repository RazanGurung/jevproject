/**
 * Funding rendering - funding display rendering
 */

import { AppState } from '../state/store.js';
import { fmtPrice } from '../utils/format.js';
import { apiPost } from '../services/api.js';

async function renderFundingTable() {
  const currentCoin = AppState.trading.currentCoin;
  
  const $ = id => document.getElementById(id);
  const container = $('fundingTable');
  if (!container) return;
  
  try {
    const hourMs = 3_600_000;
    const funding = await apiPost('/api/hl', {
      type: 'fundingHistory',
      coin: currentCoin,
      startTime: Math.floor((Date.now() - 86400000 * 7) / hourMs) * hourMs,
    });
    
    if (!funding || !funding.length) {
      container.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:11px;">No funding data</div>';
      return;
    }
    
    let html = '<table class="data-table" style="font-size:10px;"><thead><tr><th>Time</th><th>Rate</th><th>APY</th></tr></thead><tbody>';
    
    funding.slice(0, 20).forEach(f => {
      const rate = parseFloat(f.fundingRate || 0);
      const ratePct = (rate * 100).toFixed(4);
      const apyPct = (rate * 3 * 365).toFixed(2);
      const col = rate >= 0 ? 'var(--text)' : 'var(--text2)';
      const time = f.time ? new Date(f.time).toLocaleString() : '—';
      
      html += `<tr>
        <td style="color:var(--text3)">${time}</td>
        <td style="color:${col}">${ratePct}%</td>
        <td style="color:${col}">${apyPct}%</td>
      </tr>`;
    });
    
    html += '</tbody></table>';
    container.innerHTML = html;
  } catch(e) {
    console.error('Render funding error:', e);
    container.innerHTML = '<div style="padding:12px;color:var(--text3);font-size:11px;">Error loading funding</div>';
  }
}

export {
  renderFundingTable
};