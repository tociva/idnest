import { createPublicHttpServer } from "./direct-server";

const app = (_request: unknown, response: { end: (body: string) => void }) => {
  response.end("ok");
};

describe("HTTP server runtime", () => {
  it("creates a plaintext HTTP server for the private origin", () => {
    const server = createPublicHttpServer({
      app,
      port: 3000,
      label: "test",
    });

    expect(server.constructor.name).toBe("Server");
  });

  it("rejects invalid ports", () => {
    expect(() =>
      createPublicHttpServer({
        app,
        port: 0,
        label: "test",
      }),
    ).toThrow(/application port must be an integer/);
  });
});
