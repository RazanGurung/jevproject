/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getOpenPopoverId,
  positionPopover,
  resetPopoverControllerForTests,
  togglePopover,
} from '../popover-controller.js';

function config(id, trigger, panel, extra = {}) {
  return {
    id,
    trigger,
    panel,
    triggers: `[data-popover-trigger="${id}"]`,
    openClass: 'active',
    ...extra,
  };
}

beforeEach(() => {
  resetPopoverControllerForTests();
  document.body.innerHTML = `
    <button id="draw" data-popover-trigger="draw" aria-expanded="false">Draw</button>
    <div id="drawPanel" style="display:none"><button id="line">Line</button><button id="box">Box</button></div>
    <button id="ind" data-popover-trigger="ind" aria-expanded="false">IND</button>
    <div id="indPanel" style="display:none"><input id="check" type="checkbox"></div>
    <button id="outside">Outside</button>
  `;
});

describe('popover controller', () => {
  it('toggles the same trigger and keeps aria-expanded truthful', () => {
    const trigger = document.getElementById('draw');
    const panel = document.getElementById('drawPanel');
    togglePopover(config('draw', trigger, panel));
    expect(panel.style.display).toBe('flex');
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(trigger.classList.contains('active')).toBe(true);
    // Open panels always sit on body (portaled or already there).
    expect(panel.parentElement).toBe(document.body);

    togglePopover(config('draw', trigger, panel));
    expect(panel.style.display).toBe('none');
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('portals nested panels to body and restores them on close', () => {
    document.body.innerHTML = `
      <div id="clipper" style="overflow:hidden">
        <button id="draw" data-popover-trigger="draw" aria-expanded="false">Draw</button>
        <div id="drawPanel" style="display:none"><button id="line">Line</button></div>
      </div>
    `;
    const panel = document.getElementById('drawPanel');
    const home = document.getElementById('clipper');
    togglePopover(config('draw', document.getElementById('draw'), panel));
    expect(panel.parentElement).toBe(document.body);
    expect(panel.dataset.popoverPortal).toBe('1');
    togglePopover(config('draw', document.getElementById('draw'), panel));
    expect(panel.parentElement).toBe(home);
    expect(panel.dataset.popoverPortal).toBeUndefined();
  });

  it('closes the previous surface before opening another', () => {
    const drawClose = vi.fn();
    togglePopover(config('draw', document.getElementById('draw'), document.getElementById('drawPanel'), { onClose: drawClose }));
    togglePopover(config('ind', document.getElementById('ind'), document.getElementById('indPanel')));

    expect(drawClose).toHaveBeenCalledOnce();
    expect(document.getElementById('drawPanel').style.display).toBe('none');
    expect(document.getElementById('indPanel').style.display).toBe('flex');
    expect(getOpenPopoverId()).toBe('ind');
  });

  it('dismisses outside and restores trigger focus on Escape', () => {
    const trigger = document.getElementById('draw');
    const panel = document.getElementById('drawPanel');
    togglePopover(config('draw', trigger, panel));
    document.getElementById('outside').click();
    expect(panel.style.display).toBe('none');

    togglePopover(config('draw', trigger, panel));
    document.getElementById('line').focus();
    const bubbledToChart = vi.fn();
    window.addEventListener('keydown', bubbledToChart);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.removeEventListener('keydown', bubbledToChart);
    expect(panel.style.display).toBe('none');
    expect(document.activeElement).toBe(trigger);
    expect(bubbledToChart).not.toHaveBeenCalled();
  });

  it('can keep a surface open on outside click when opted out', () => {
    const trigger = document.getElementById('draw');
    const panel = document.getElementById('drawPanel');
    togglePopover(config('draw', trigger, panel, { closeOnOutsideClick: false }));
    document.getElementById('outside').click();
    expect(panel.style.display).toBe('flex');
    expect(getOpenPopoverId()).toBe('draw');

    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(panel.style.display).toBe('none');
  });

  it('supports arrow, Home, and End traversal for menu-like content', () => {
    const panel = document.getElementById('drawPanel');
    togglePopover(config('draw', document.getElementById('draw'), panel, { itemsSelector: 'button' }));
    const line = document.getElementById('line');
    const box = document.getElementById('box');
    line.focus();
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    expect(document.activeElement).toBe(box);
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
    expect(document.activeElement).toBe(line);
    line.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
    expect(document.activeElement).toBe(box);
  });

  it('dismisses the open surface on resize', () => {
    const panel = document.getElementById('indPanel');
    togglePopover(config('ind', document.getElementById('ind'), panel));
    window.dispatchEvent(new Event('resize'));
    expect(panel.style.display).toBe('none');
  });

  it('caps a scrollable panel to the viewport when its trigger is below the fold', () => {
    const trigger = document.getElementById('ind');
    const panel = document.getElementById('indPanel');
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 332 });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 600 });
    Object.defineProperty(panel, 'scrollHeight', { configurable: true, value: 557 });
    Object.defineProperty(panel, 'offsetWidth', { configurable: true, value: 286 });
    trigger.getBoundingClientRect = () => ({ top: 397, bottom: 421, left: 200, right: 260, width: 60, height: 24 });

    positionPopover(panel, trigger, { minWidth: 286, scrollable: true });

    expect(panel.style.maxHeight).toBe('324px');
    expect(panel.style.top).toBe('4px');
  });
});
