/**
 * URL validation for navigation commands — blocks dangerous schemes and cloud metadata endpoints.
 * Localhost and private IPs are allowed (primary use case: QA testing local dev servers).
 */

const BLOCKED_METADATA_HOSTS = [
  '169.254.169.254',  // AWS/GCP/Azure instance metadata
  'fd00::',           // IPv6 unique local (metadata in some cloud setups)
  'metadata.google.internal', // GCP metadata
];

export function validateNavigationUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid URL: ${url}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(
      `Blocked: scheme "${parsed.protocol}" is not allowed. Only http: and https: URLs are permitted.`
    );
  }

  const hostname = parsed.hostname.toLowerCase();
  if (BLOCKED_METADATA_HOSTS.includes(hostname)) {
    throw new Error(
      `Blocked: ${hostname} is a cloud metadata endpoint. Access is denied for security.`
    );
  }
}
