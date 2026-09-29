export function isLocalPage(url: string, origin: string) {
  try {
    const parsed = new URL(url);
    return parsed.origin === origin && !parsed.username && !parsed.password;
  } catch {
    return false;
  }
}

export function isExternalLink(url: unknown): url is string {
  if (typeof url !== "string" || url.length > 8192) return false;
  try {
    const parsed = new URL(url);
    return (
      ["https:", "http:"].includes(parsed.protocol) &&
      !parsed.username &&
      !parsed.password
    );
  } catch {
    return false;
  }
}

export function isGoogleAuthorization(url: unknown): url is string {
  if (!isExternalLink(url)) return false;
  const parsed = new URL(url);
  return (
    parsed.origin === "https://accounts.google.com" &&
    parsed.pathname === "/o/oauth2/v2/auth"
  );
}

// Resolves true once the work settles (either way), or false after the limit.
export async function settleWithin(
  work: Promise<unknown>,
  milliseconds: number,
): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), milliseconds);
  });
  try {
    return await Promise.race([
      work.then(
        () => true,
        () => true,
      ),
      limit,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
