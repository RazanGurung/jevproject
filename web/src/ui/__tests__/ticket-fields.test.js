/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it } from 'vitest';

describe('ticket-fields', () => {
  beforeEach(() => {
    document.body.innerHTML = `
      <input id="priceInput" value="101.25" />
      <input id="sizeInput" value="250" />
      <input id="sizeSlider" value="250" />
      <input id="tpPctInput" value="2" />
      <input id="slPctInput" value="1" />
      <select id="playbookSelect"><option selected>Manual</option></select>
      <div id="playbookHint"></div>
      <button id="placeBtn">Place Order</button>
      <input id="scaleTotal" value="1000" />
      <input id="scaleOrders" value="4" />
      <input id="scaleHigh" value="110" />
      <input id="scaleLow" value="90" />
    `;
  });

  it('returns canonical ticket field elements including the submit button', async () => {
    const { getTicketFieldElements } = await import('../ticket-fields.js');
    const fields = getTicketFieldElements();

    expect(fields.priceInput?.id).toBe('priceInput');
    expect(fields.sizeInput?.id).toBe('sizeInput');
    expect(fields.playbookSelect?.id).toBe('playbookSelect');
    expect(fields.submitButton?.id).toBe('placeBtn');
  });

  it('reads and resets the scale form through one helper', async () => {
    const { readScaleForm, resetScaleForm } = await import('../ticket-fields.js');

    expect(readScaleForm()).toEqual({
      total: 1000,
      numOrders: 4,
      high: 110,
      low: 90,
    });

    resetScaleForm();

    expect(document.getElementById('scaleTotal')?.value).toBe('');
    expect(document.getElementById('scaleOrders')?.value).toBe('5');
    expect(document.getElementById('scaleHigh')?.value).toBe('');
    expect(document.getElementById('scaleLow')?.value).toBe('');
  });

  it('lets ticket reads override the submit button and tracked price', async () => {
    document.body.innerHTML += '<button id="compactBuyBtn">Buy</button>';
    const { readOrderTicketInput } = await import('../ticket-submit-state.js');
    const compactBuyBtn = document.getElementById('compactBuyBtn');

    const ticket = readOrderTicketInput({
      submitButtonEl: compactBuyBtn,
      rawLimitPrice: 99.5,
    });

    expect(ticket.submitButtonEl).toBe(compactBuyBtn);
    expect(ticket.rawLimitPrice).toBe(99.5);
    expect(ticket.sizeUsd).toBe(250);
  });
});
