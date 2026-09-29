function scheduleFrame(callback, fallbackDelayMs = 16) {
  if (typeof globalThis.requestAnimationFrame === 'function') {
    return globalThis.requestAnimationFrame(callback);
  }
  return globalThis.setTimeout(callback, fallbackDelayMs);
}

// Serialize expensive, independent rendering units across animation frames.
// A shared queue matters here: separate chart overlays scheduling their own
// requestAnimationFrame callbacks would otherwise still run in one browser
// rendering task and recreate the long task this queue is intended to avoid.
const frameWorkQueue = [];
let frameWorkScheduled = false;

function requestNextFrameWork() {
  if (frameWorkScheduled || frameWorkQueue.length === 0) return;
  frameWorkScheduled = true;
  scheduleFrame(() => {
    frameWorkScheduled = false;
    let work = null;
    while (frameWorkQueue.length > 0 && !work) {
      const candidate = frameWorkQueue.shift();
      if (!candidate.cancelled) work = candidate;
    }
    if (work) {
      try { work.callback(); } catch (error) {
        globalThis.console?.error?.('[frame-work] callback failed:', error);
      }
    }
    requestNextFrameWork();
  });
}

function scheduleFrameWork(callback) {
  const work = { callback, cancelled: false };
  frameWorkQueue.push(work);
  requestNextFrameWork();
  return work;
}

function cancelFrameWork(work) {
  if (work) work.cancelled = true;
}

export {
  cancelFrameWork,
  scheduleFrame,
  scheduleFrameWork,
};
