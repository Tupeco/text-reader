// Client for the optional translation API (server/, compose service "api"). When the app is hosted
// without it, or the device is offline, the engine list is empty and translation runs on the device.
import { url } from './catalog';

export type ServerEngine = { id: string; label: string };

let engines: Promise<ServerEngine[]> | undefined;

/** Engines the server offers, in its order of preference; [] when there is no API or no network. */
export function serverEngines(refresh = false): Promise<ServerEngine[]> {
  if (refresh || !engines) {
    engines = (async () => {
      if (!navigator.onLine) return [];
      try {
        const res = await fetch(url('api/translate/engines'), { signal: AbortSignal.timeout(5000), cache: 'no-store' });
        if (!res.ok || !res.headers.get('Content-Type')?.includes('application/json')) return [];
        const body = (await res.json()) as { engines?: ServerEngine[] };
        return Array.isArray(body.engines) ? body.engines.filter((e) => e && typeof e.id === 'string') : [];
      } catch {
        return [];
      }
    })();
    // Retry next time if this attempt found nothing (e.g. briefly offline).
    void engines.then((list) => {
      if (!list.length) engines = undefined;
    });
  }
  return engines;
}

/** Translates paragraphs with a server engine. Throws with the server's message on failure. */
export async function translateOnline(engine: string, source: string, target: string, texts: string[]): Promise<string[]> {
  const res = await fetch(url('api/translate'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ engine, source, target, texts }),
    // The language model engine can take a while on a CPU-only server.
    signal: AbortSignal.timeout(200_000),
  });
  const body = (await res.json().catch(() => ({}))) as { texts?: unknown; error?: string };
  if (!res.ok) throw new Error(body.error ?? `server error ${res.status}`);
  if (!Array.isArray(body.texts) || body.texts.length !== texts.length) throw new Error('unexpected server response');
  return body.texts.map(String);
}
