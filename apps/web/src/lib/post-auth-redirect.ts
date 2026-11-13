const RETURN_PATH_KEY = "acompany:post-auth-return-path";

export function rememberPostAuthReturnPath(pathname: string, search = "") {
  if (!pathname.startsWith("/app") && pathname !== "/integrations/setup") return;
  try {
    window.sessionStorage.setItem(RETURN_PATH_KEY, `${pathname}${search}`);
  } catch {
    // Ignore storage failures in private browsing.
  }
}

export function consumePostAuthReturnPath(): string | null {
  try {
    const saved = window.sessionStorage.getItem(RETURN_PATH_KEY);
    if (!saved) return null;
    window.sessionStorage.removeItem(RETURN_PATH_KEY);
    if (saved.startsWith("/app") || saved.startsWith("/integrations/setup")) {
      return saved;
    }
    return null;
  } catch {
    return null;
  }
}

export function clearPostAuthReturnPath() {
  try {
    window.sessionStorage.removeItem(RETURN_PATH_KEY);
  } catch {
    // Ignore storage failures.
  }
}
