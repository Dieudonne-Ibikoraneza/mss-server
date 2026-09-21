import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Whether an IP address belongs to somewhere a server must never be talked into
 * fetching for a user: loopback, private networks, link-local (including the cloud
 * metadata address 169.254.169.254), carrier-grade NAT, multicast and reserved ranges.
 */
export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 192 && b === 0) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d) is judged by the IPv4 address inside it.
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]);
    return (
      lower.startsWith('fc') || // unique local fc00::/7
      lower.startsWith('fd') ||
      /^fe[89ab]/.test(lower) || // link-local fe80::/10
      lower.startsWith('ff') // multicast
    );
  }
  return true; // not an IP at all — never treat it as safe
};

/**
 * Throws unless `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Used before the server fetches a URL an editor typed in.
 */
export const assertPublicHttpUrl = async (rawUrl: string): Promise<URL> => {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Not a valid URL.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('Only http(s) URLs are allowed.');
  }
  if (url.username || url.password) throw new Error('URLs with credentials are not allowed.');

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host)
    ? [host]
    : (await lookup(host, { all: true, verbatim: true })).map((entry) => entry.address);
  if (addresses.length === 0 || addresses.some(isPrivateAddress)) {
    throw new Error('That address is not allowed.');
  }
  return url;
};
