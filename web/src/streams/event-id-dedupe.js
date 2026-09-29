/**
 * Connection-scoped event-id dedupe with a strict memory/work bound.
 *
 * Backend event ids are monotonic only for the lifetime of one server process,
 * so callers reset this helper whenever they create a replacement socket.
 */
function createEventIdDeduper(maxEntries = 1000) {
  const ids = new Set();
  const limit = Math.max(1, Number(maxEntries) || 1);

  return {
    reset() {
      ids.clear();
    },

    seen(eventId) {
      if (!eventId && eventId !== 0) return false;
      const key = String(eventId);
      if (!key || key === '0') return false;
      if (ids.has(key)) return true;

      ids.add(key);
      if (ids.size > limit) {
        ids.delete(ids.values().next().value);
      }
      return false;
    },
  };
}

export { createEventIdDeduper };
