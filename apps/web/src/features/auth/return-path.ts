const DEFAULT_RETURN_PATH = "/app";

export const getSafeReturnPath = (
  candidate: string | null | undefined,
  origin = globalThis.location?.origin,
): string => {
  if (
    !candidate ||
    !origin ||
    candidate.includes("\\") ||
    [...candidate].some((character) => character.charCodeAt(0) < 32)
  ) {
    return DEFAULT_RETURN_PATH;
  }

  if (candidate.startsWith("//")) {
    return DEFAULT_RETURN_PATH;
  }

  try {
    const url = new URL(candidate, origin);

    if (url.origin !== origin || !url.pathname.startsWith("/")) {
      return DEFAULT_RETURN_PATH;
    }

    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return DEFAULT_RETURN_PATH;
  }
};
