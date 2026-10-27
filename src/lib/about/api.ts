/** Only the public aggregate API is reachable from the website. */
const configuredBase = import.meta.env.PUBLIC_ABOUT_API_BASE?.trim() ?? '';

const isLoopback = (hostname: string) => ['localhost', '127.0.0.1', '[::1]', '::1'].includes(hostname);

export function getAboutApiBase(): string | null {
  if (!configuredBase) return null;
  try {
    const url = new URL(configuredBase);
    if (url.username || url.password || url.search || url.hash) return null;
    const localPage = typeof window !== 'undefined' && isLoopback(window.location.hostname);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname) && localPage)) {
      return null;
    }
    return url.href.replace(/\/$/, '');
  } catch {
    return null;
  }
}

export class AboutApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly retryAfter: number | null = null
  ) {
    super('The public activity service is unavailable.');
    this.name = 'AboutApiError';
  }
}

export async function requestAboutApi<T = unknown>(path: string, options: RequestInit = {}): Promise<T> {
  const base = getAboutApiBase();
  if (!base || !path.startsWith('/v1/')) throw new AboutApiError(0);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timeout = window.setTimeout(abort, 10_000);
  try {
    const headers = new Headers(options.headers);
    if (!headers.has('Accept')) headers.set('Accept', 'application/json');
    const response = await fetch(`${base}${path}`, {
      ...options,
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      signal: controller.signal,
      headers,
    });
    if (!response.ok) {
      const seconds = Number(response.headers.get('Retry-After'));
      throw new AboutApiError(response.status, Number.isFinite(seconds) && seconds > 0 ? seconds : null);
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof AboutApiError || controller.signal.aborted) throw error;
    throw new AboutApiError(0);
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abort);
  }
}
