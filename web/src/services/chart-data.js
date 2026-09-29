import { chartCandlesPost } from './api.js';

// Thin client for the backend-owned chart read model. Callers select a series
// and range; cache coverage, upstream lane assignment, merging and healing are
// server responsibilities. Uses the shared transient-retry ladder so a single
// cold passthrough 502/timeout does not blank the visible chart.
export function fetchChartCandles({
  coin,
  interval,
  startTime,
  endTime,
  dex = '',
  urgency = 'visible',
  signal,
  background = false,
} = {}) {
  return chartCandlesPost({
    coin,
    interval,
    startTime,
    endTime,
    ...(dex ? { dex } : {}),
    urgency,
  }, { signal, background });
}
