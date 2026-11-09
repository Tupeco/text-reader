// @ts-check
// Abuse limits for a public endpoint that spends the operator's translation quota:
// requests per client per hour, and translated characters per day across all clients.
import { EngineError } from './engine.mjs';

/** @param {{ perClientPerHour: number, charsPerDay: number, now?: () => number }} opts  0 disables a limit. */
export function createLimits({ perClientPerHour, charsPerDay, now = Date.now }) {
  /** @type {Map<string, number[]>} request times per client within the last hour */
  const recent = new Map();
  let day = '';
  let usedToday = 0;

  return {
    take(/** @type {string} */ client, /** @type {number} */ chars) {
      const t = now();
      if (perClientPerHour > 0) {
        const times = (recent.get(client) ?? []).filter((x) => t - x < 3_600_000);
        if (times.length >= perClientPerHour) throw new EngineError('Too many translations from this device, try again later', 429);
        times.push(t);
        recent.set(client, times);
        if (recent.size > 10_000) for (const [k, v] of recent) if (!v.some((x) => t - x < 3_600_000)) recent.delete(k);
      }
      if (charsPerDay > 0) {
        const today = new Date(t).toISOString().slice(0, 10);
        if (today !== day) (day = today), (usedToday = 0);
        if (usedToday + chars > charsPerDay) throw new EngineError('The server\'s daily translation allowance is used up', 429);
        usedToday += chars;
      }
    },
  };
}
