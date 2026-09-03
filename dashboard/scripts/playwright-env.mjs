const proxyEnvironmentKeys = new Set([
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
  "no_proxy",
]);

export function withoutProxyEnvironment(environment) {
  return Object.fromEntries(
    Object.entries(environment).filter(([key]) => !proxyEnvironmentKeys.has(key)),
  );
}
