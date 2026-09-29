import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import http from "node:http";
import ipaddr from "ipaddr.js";

export function canonicalUrl(value: string): string {
  const url = new URL(value);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password
  )
    throw new Error("Use a public HTTP or HTTPS job URL without credentials.");
  url.hash = "";
  for (const name of [...url.searchParams.keys()])
    if (
      /^utm_/i.test(name) ||
      ["gclid", "fbclid", "msclkid"].includes(name.toLowerCase())
    )
      url.searchParams.delete(name);
  url.searchParams.sort();
  return url.toString();
}
export function isPublicAddress(address: string) {
  if (!ipaddr.isValid(address)) return false;
  const parsed = ipaddr.parse(address);
  return (
    parsed.range() === "unicast" &&
    (parsed.kind() === "ipv4" || /^[23]/i.test(address))
  );
}
export async function publicRequest(
  value: string,
  options: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
    maxBytes?: number;
    redirects?: number;
    httpsOnly?: boolean;
    signal?: AbortSignal;
  } = {},
): Promise<{
  status: number;
  text: string;
  url: string;
  headers: http.IncomingHttpHeaders;
}> {
  const url = new URL(canonicalUrl(value));
  if (options.httpsOnly && url.protocol !== "https:")
    throw new Error("The AI endpoint must use HTTPS.");
  if (url.port && !["80", "443"].includes(url.port))
    throw new Error("Only public web ports are supported.");
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(hostname)
    ? [{ address: hostname, family: isIP(hostname) }]
    : await lookup(hostname, { all: true });
  if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address)))
    throw new Error("Private and local network addresses cannot be fetched.");
  const chosen = addresses[0];
  options.signal?.throwIfAborted();
  // Pin the validated DNS result into this connection to prevent DNS rebinding.
  const result = await new Promise<{
    status: number;
    text: string;
    headers: http.IncomingHttpHeaders;
  }>((resolve, reject) => {
    const request = (url.protocol === "https:" ? https : http).request(
      url,
      {
        method: options.method || "GET",
        signal: options.signal,
        headers: {
          "User-Agent": "Fieldwork/0.1 (personal application tracker)",
          ...options.headers,
        },
        lookup: ((
          _host: string,
          _opts: unknown,
          callback: (error: null, address: string, family: number) => void,
        ) => callback(null, chosen.address, chosen.family)) as never,
        family: chosen.family,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 2_000_000))
            request.destroy(new Error("Response exceeds the size limit."));
          else chunks.push(chunk);
        });
        response.on("end", () =>
          resolve({
            status: response.statusCode || 500,
            text: Buffer.concat(chunks).toString("utf8"),
            headers: response.headers,
          }),
        );
        response.on("error", reject);
      },
    );
    const deadline = setTimeout(
      () => request.destroy(new Error("Request timed out.")),
      30000,
    );
    request.on("close", () => clearTimeout(deadline));
    request.on("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
  if (
    [301, 302, 303, 307, 308].includes(result.status) &&
    result.headers.location
  ) {
    if (options.method && options.method !== "GET")
      throw new Error("API redirects are not accepted.");
    if ((options.redirects ?? 0) >= 4) throw new Error("Too many redirects.");
    return publicRequest(new URL(result.headers.location, url).toString(), {
      ...options,
      redirects: (options.redirects ?? 0) + 1,
    });
  }
  return { ...result, url: url.toString() };
}
