import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';

/** The 16 bytes of an IPv6 address, from any spelling (`::`, `::ffff:7f00:1`, `::ffff:127.0.0.1`, …). */
const ipv6Bytes = (address: string): number[] | null => {
  let text = address.toLowerCase();
  const zone = text.indexOf('%');
  if (zone !== -1) text = text.slice(0, zone);

  // A dotted IPv4 tail counts as the last two groups.
  const dotted = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted.slice(1).map(Number);
    if ([a, b, c, d].some((part) => part > 255)) return null;
    text =
      text.slice(0, dotted.index) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part === '' ? [] : part.split(':'));
  const head = parse(halves[0]);
  const tail = halves.length === 2 ? parse(halves[1]) : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return null;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill('0'), ...tail];
  if (groups.length !== 8) return null;

  const bytes: number[] = [];
  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
    const value = parseInt(group, 16);
    bytes.push(value >> 8, value & 0xff);
  }
  return bytes;
};

const isPrivateIpv4 = (a: number, b: number) =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 100 && b >= 64 && b <= 127) ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b <= 31) ||
  (a === 192 && b === 168) ||
  (a === 192 && b === 0) ||
  (a === 198 && (b === 18 || b === 19)) ||
  a >= 224;

/**
 * Whether an IP address belongs to somewhere a server must never be talked into
 * fetching for a user: loopback, private networks, link-local (including the cloud
 * metadata address 169.254.169.254), carrier-grade NAT, multicast and reserved ranges.
 * IPv6 addresses that merely wrap an IPv4 one (`::ffff:7f00:1`, NAT64, 6to4) are judged
 * by the IPv4 address inside — in whatever notation they are written.
 */
export const isPrivateAddress = (address: string): boolean => {
  const version = isIP(address);
  if (version === 4) {
    const [a, b] = address.split('.').map(Number);
    return isPrivateIpv4(a, b);
  }
  if (version !== 6) return true; // not an IP at all — never treat it as safe

  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const allZero = (from: number, to: number) => bytes.slice(from, to).every((byte) => byte === 0);

  if (allZero(0, 15) && (bytes[15] === 0 || bytes[15] === 1)) return true; // :: and ::1
  // IPv4-mapped ::ffff:a.b.c.d and IPv4-compatible ::a.b.c.d
  if (allZero(0, 10) && ((bytes[10] === 0xff && bytes[11] === 0xff) || allZero(10, 12))) {
    return isPrivateIpv4(bytes[12], bytes[13]);
  }
  // NAT64 64:ff9b::/96 carries an IPv4 address in its last four bytes
  if (
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    allZero(4, 12)
  ) {
    return isPrivateIpv4(bytes[12], bytes[13]);
  }
  // 6to4 2002:AABB:CCDD::/16 carries one right after the prefix
  if (bytes[0] === 0x20 && bytes[1] === 0x02) return isPrivateIpv4(bytes[2], bytes[3]);

  return (
    (bytes[0] & 0xfe) === 0xfc || // unique local fc00::/7
    (bytes[0] === 0xfe && (bytes[1] & 0xc0) === 0x80) || // link-local fe80::/10
    bytes[0] === 0xff // multicast
  );
};

/** Parses `rawUrl` and returns it with the public addresses its host resolves to — or throws. */
const resolvePublicUrl = async (rawUrl: string): Promise<{ url: URL; addresses: string[] }> => {
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
  return { url, addresses };
};

/**
 * Throws unless `rawUrl` is an http(s) URL whose host resolves only to public
 * addresses. Used before the server fetches a URL an editor typed in.
 */
export const assertPublicHttpUrl = async (rawUrl: string): Promise<URL> =>
  (await resolvePublicUrl(rawUrl)).url;

/**
 * Downloads a URL an editor supplied, safely: the host is resolved once, every address must be
 * public, and the connection is then made to *that* address — so the name cannot resolve
 * somewhere else between the check and the request (DNS rebinding). Redirects are not followed
 * (a redirect could point anywhere), and the size and time are capped. Returns null on any failure.
 */
export const fetchPublicFile = async (
  rawUrl: string,
  options: { timeoutMs: number; maxBytes: number },
): Promise<{ contentType: string; buffer: Buffer } | null> => {
  let resolved: { url: URL; addresses: string[] };
  try {
    resolved = await resolvePublicUrl(rawUrl);
  } catch {
    return null;
  }
  const { url, addresses } = resolved;
  const address = addresses[0];
  const family = isIP(address);
  const client = url.protocol === 'https:' ? https : http;

  return new Promise((resolve) => {
    const request = client.get(
      url,
      {
        timeout: options.timeoutMs,
        // Connect to the address we checked; the URL's host name is still used for TLS.
        lookup: (_host, lookupOptions, callback) => {
          if ((lookupOptions as { all?: boolean }).all) {
            (callback as unknown as (e: null, r: { address: string; family: number }[]) => void)(
              null,
              [{ address, family }],
            );
          } else {
            callback(null, address, family);
          }
        },
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.resume();
          resolve(null);
          return;
        }
        const declared = Number(response.headers['content-length'] ?? 0);
        if (declared > options.maxBytes) {
          response.destroy();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > options.maxBytes) {
            response.destroy();
            resolve(null);
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () =>
          resolve({
            contentType: (response.headers['content-type'] ?? '').split(';')[0].trim(),
            buffer: Buffer.concat(chunks),
          }),
        );
        response.on('error', () => resolve(null));
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(null));
  });
};
