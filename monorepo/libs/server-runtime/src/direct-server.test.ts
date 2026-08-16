import { createDirectPublicServer } from "./direct-server";

const app = (_request: unknown, response: { end: (body: string) => void }) => {
  response.end("ok");
};

describe("direct server runtime", () => {
  it("uses HTTP when production HTTPS is disabled", () => {
    const server = createDirectPublicServer({
      app,
      port: 3000,
      label: "test",
      httpsEnabledVariable: "TEST_HTTPS_ENABLED",
      environment: { TEST_HTTPS_ENABLED: "false" },
    });

    expect(server.constructor.name).toBe("Server");
  });

  it("rejects invalid boolean configuration", () => {
    expect(() =>
      createDirectPublicServer({
        app,
        port: 3000,
        label: "test",
        httpsEnabledVariable: "TEST_HTTPS_ENABLED",
        environment: { TEST_HTTPS_ENABLED: "yes" },
      }),
    ).toThrow(/must be true or false/);
  });

  it("requires TLS paths when HTTPS is enabled", () => {
    expect(() =>
      createDirectPublicServer({
        app,
        port: 3000,
        label: "test",
        httpsEnabledVariable: "TEST_HTTPS_ENABLED",
        environment: { TEST_HTTPS_ENABLED: "true" },
      }),
    ).toThrow(/TLS_CERT_PATH is required/);
  });

  it("rejects invalid ports", () => {
    expect(() =>
      createDirectPublicServer({
        app,
        port: 0,
        label: "test",
        httpsEnabledVariable: "TEST_HTTPS_ENABLED",
        environment: {},
      }),
    ).toThrow(/application port must be an integer/);
  });
});
