/** @vitest-environment jsdom */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const updateChartLevels = vi.fn();
const scheduleChartRender = vi.fn();
const renderOrderFlow = vi.fn();
const renderLiquidations = vi.fn();
const renderDomLadder = vi.fn();

vi.mock('../../chart/chart-levels.js', () => ({ updateChartLevels }));
vi.mock('../../chart/chart-render.js', () => ({ scheduleChartRender }));
vi.mock('../trades.js', () => ({ renderOrderFlow, renderLiquidations }));
vi.mock('../dom-ladder.js', () => ({ renderDomLadder }));

describe('layout render scheduler', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();
    document.body.innerHTML = '<div id="mainLayout"></div>';
    const scheduler = await import('../layout-scheduler.js');
    scheduler.resetLayoutSchedulerForTests();
  });

  it('coalesces chart and book work into one flush', async () => {
    const scheduler = await import('../layout-scheduler.js');
    scheduler.scheduleLayoutRender({ chart: true, reason: 'first' });
    scheduler.scheduleLayoutRender({ book: true, reason: 'second' });
    await scheduler.flushLayoutRender();

    expect(updateChartLevels).toHaveBeenCalledTimes(1);
    expect(scheduleChartRender).toHaveBeenCalledTimes(1);
    expect(renderOrderFlow).toHaveBeenCalledTimes(1);
    expect(renderDomLadder).toHaveBeenCalledTimes(1);
    expect(renderLiquidations).toHaveBeenCalledTimes(1);
  });

  it('does not redraw a hidden mobile chart', async () => {
    document.getElementById('mainLayout').className = 'is-mobile';
    document.getElementById('mainLayout').dataset.mobileView = 'book';
    const scheduler = await import('../layout-scheduler.js');
    scheduler.scheduleLayoutRender({ chart: true });
    await scheduler.flushLayoutRender();

    expect(scheduleChartRender).not.toHaveBeenCalled();
  });
});
