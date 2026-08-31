import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from "node:http";

const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;

export interface HttpServerOptions {
  app: RequestListener;
  port: number;
  label: string;
  environment?: NodeJS.ProcessEnv;
}

export interface StartedServers {
  publicServer: HttpServer;
  healthServer?: HttpServer;
}

function validPort(value: number, name: string): number {
  if (!Number.isInteger(value) || value < MINIMUM_PORT || value > MAXIMUM_PORT) {
    throw new Error(`${name} must be an integer between 1 and ${MAXIMUM_PORT}`);
  }
  return value;
}

function environmentPort(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: number,
): number {
  const configured = environment[name]?.trim();
  return validPort(configured ? Number(configured) : fallback, name);
}

function booleanValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  fallback: boolean,
): boolean {
  const value = environment[name]?.trim() ?? "";
  if (value === "") return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  throw new Error(`${name} must be true or false when set`);
}

export function createPublicHttpServer(options: HttpServerOptions): HttpServer {
  validPort(options.port, "application port");
  return createHttpServer(options.app);
}

function createInternalHealthServer(label: string): HttpServer {
  return createHttpServer((request, response) => {
    if (
      request.method === "GET" &&
      (request.url === "/health" ||
        request.url === "/health/live" ||
        request.url === "/health/ready")
    ) {
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ status: "ok", service: label }));
      return;
    }
    response.writeHead(404, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ error: "not_found" }));
  });
}

export function startHttpServers(options: HttpServerOptions): StartedServers {
  const environment = options.environment ?? process.env;
  const host = environment.HOST?.trim() || "0.0.0.0";
  const publicServer = createPublicHttpServer(options);
  const healthEnabled = booleanValue(
    environment,
    "INTERNAL_HEALTH_SERVER_ENABLED",
    false,
  );
  let healthServer: HttpServer | undefined;

  if (healthEnabled) {
    const healthPort = environmentPort(environment, "INTERNAL_HEALTH_PORT", 3001);
    healthServer = createInternalHealthServer(options.label);
    healthServer.listen(healthPort, "127.0.0.1", () => {
      console.log(`${options.label} internal health listening on 127.0.0.1:${healthPort}`);
    });
  }

  publicServer.listen(options.port, host, () => {
    console.log(`${options.label} listening on http://${host}:${options.port}`);
  });

  return { publicServer, healthServer };
}
