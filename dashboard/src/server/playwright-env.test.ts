import { describe, expect, it } from "vitest";

import { withoutProxyEnvironment } from "../../scripts/playwright-env.mjs";

describe("Playwright 本地运行环境", () => {
  it("移除会干扰 localhost 健康检查的代理变量", () => {
    const result = withoutProxyEnvironment({
      HTTP_PROXY: "http://proxy.example:8080",
      HTTPS_PROXY: "http://proxy.example:8080",
      ALL_PROXY: "socks5://proxy.example:1080",
      http_proxy: "http://proxy.example:8080",
      https_proxy: "http://proxy.example:8080",
      all_proxy: "socks5://proxy.example:1080",
      NO_PROXY: "example.com",
      KEEP_ME: "yes",
    });

    expect(result).toEqual({ KEEP_ME: "yes" });
  });
});
