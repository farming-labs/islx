/**
 * Whether a state-changing request came from the app's own origin. Server actions run only for
 * same-origin requests, or requests from an origin the app allows.
 */

/** The origin a request claims to come from (Origin, then Referer), or why it has none. */
function sourceOrigin(request: Request): { origin: string | null } | { invalid: true } {
  const value =
    request.headers.get("origin")?.trim() || request.headers.get("referer")?.trim() || null;
  if (!value) return { origin: null };
  if (value === "null") return { invalid: true };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return { invalid: true };
    return { origin: parsed.origin };
  } catch {
    return { invalid: true };
  }
}

/**
 * The source matches the `Host` header and the request URL's scheme. The scheme check blocks a
 * protocol-downgrade request; behind a TLS-terminating proxy that rebuilds `request.url` as
 * `http:`, list the browser origin in `allowedOrigins`.
 */
function matchesHost(origin: string, request: Request): boolean {
  const host = request.headers.get("host")?.trim().toLowerCase();
  if (!host) return false;
  try {
    const source = new URL(origin);
    return source.protocol === new URL(request.url).protocol && source.host.toLowerCase() === host;
  } catch {
    return false;
  }
}

function effectivePort(url: URL): string {
  if (url.port) return url.port;
  return url.protocol === "https:" ? "443" : url.protocol === "http:" ? "80" : "";
}

/**
 * Whether `origin` matches an allowed pattern: an origin (`https://app.example.com`), a host
 * (`app.example.com`), or a subdomain wildcard (`*.example.com`, `https://*.example.com:8443`).
 */
export function matchesAllowedOrigin(origin: string, pattern: string): boolean {
  const source = new URL(origin);
  if (!pattern.includes("*")) {
    return pattern.includes("://") ? source.origin === pattern : source.host === pattern;
  }
  const schemeEnd = pattern.indexOf("://");
  const scheme = schemeEnd === -1 ? null : pattern.slice(0, schemeEnd + 1);
  const hostPattern = pattern.slice(schemeEnd === -1 ? 0 : schemeEnd + 3);
  const separator = hostPattern.lastIndexOf(":");
  const [wildcardHost, port] =
    separator === -1
      ? [hostPattern, null]
      : [hostPattern.slice(0, separator), hostPattern.slice(separator + 1)];
  const baseHost = wildcardHost.slice(2);
  if (scheme && source.protocol !== scheme) return false;
  if (port ? effectivePort(source) !== port : source.port) return false;
  return source.hostname.endsWith(`.${baseHost}`) && source.hostname !== baseHost;
}

/** Validates and canonicalizes an allowed-origin pattern; throws for anything else. */
export function normalizeAllowedOrigin(value: string): string {
  const pattern = value.trim().toLowerCase();
  if (!pattern) throw new TypeError("allowedOrigins cannot contain empty values");
  if (pattern.includes("*")) {
    if (!/^(?:https?:\/\/)?\*\.[a-z0-9.-]+(?::\d+)?$/.test(pattern)) {
      throw new TypeError(`Invalid allowedOrigins pattern: ${JSON.stringify(value)}`);
    }
    return pattern;
  }
  if (pattern.includes("://")) {
    let parsed: URL;
    try {
      parsed = new URL(pattern);
    } catch {
      throw new TypeError(`Invalid allowedOrigins value: ${JSON.stringify(value)}`);
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      parsed.username ||
      parsed.password ||
      parsed.pathname !== "/" ||
      parsed.search ||
      parsed.hash
    ) {
      throw new TypeError(
        `allowedOrigins must hold origins without paths: ${JSON.stringify(value)}`,
      );
    }
    return parsed.origin;
  }
  if (/[/@?#]/.test(pattern)) {
    throw new TypeError(`allowedOrigins must hold origins or hosts: ${JSON.stringify(value)}`);
  }
  try {
    return new URL(`http://${pattern}`).host;
  } catch {
    throw new TypeError(`Invalid allowedOrigins value: ${JSON.stringify(value)}`);
  }
}

/**
 * Whether the request may run a server action: it names its origin (or `Sec-Fetch-Site:
 * same-origin`), and that origin is the request's own or an allowed one. Cross-site requests
 * run only from an allowed origin.
 */
export function isSameOriginRequest(request: Request, allowedOrigins: readonly string[]): boolean {
  const source = sourceOrigin(request);
  if ("invalid" in source) return false;
  const fetchSite = request.headers.get("sec-fetch-site")?.trim().toLowerCase();
  if (!source.origin) return fetchSite === "same-origin";
  const origin = source.origin;
  const allowed = allowedOrigins.some((pattern) => matchesAllowedOrigin(origin, pattern));
  if (!allowed && origin !== new URL(request.url).origin && !matchesHost(origin, request)) {
    return false;
  }
  return fetchSite !== "cross-site" || allowed;
}
