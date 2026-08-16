import {
  X509Certificate,
  createPrivateKey,
  createPublicKey,
} from "node:crypto";
import {
  createServer as createHttpServer,
  type RequestListener,
  type Server as HttpServer,
} from "node:http";
import {
  createServer as createHttpsServer,
  type Server as HttpsServer,
} from "node:https";
import { readFileSync } from "node:fs";

const MINIMUM_PORT = 1;
const MAXIMUM_PORT = 65_535;

export interface DirectServerOptions {
  app: RequestListener;
  port: number;
  label: string;
  httpsEnabledVariable: string;
  environment?: NodeJS.ProcessEnv;
  now?: Date;
}

export interface StartedServers {
  publicServer: HttpServer | HttpsServer;
  healthServer?: HttpServer;
}

function requiredValue(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required when direct HTTPS is enabled`);
  return value;
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

function readTlsFile(path: string, variableName: string): Buffer {
  try {
    return readFileSync(path);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`Unable to read ${variableName} at ${path}: ${reason}`);
  }
}

function validateCertificate(
  certificatePem: Buffer,
  privateKeyPem: Buffer,
  serverName: string,
  now: Date,
): void {
  let certificate: X509Certificate;
  try {
    certificate = new X509Certificate(certificatePem);
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`TLS_CERT_PATH does not contain a valid certificate: ${reason}`);
  }

  const validFrom = Date.parse(certificate.validFrom);
  const validTo = Date.parse(certificate.validTo);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validTo)) {
    throw new Error("The TLS certificate has an invalid validity period");
  }
  if (now.getTime() < validFrom) {
    throw new Error(`The TLS certificate is not valid before ${certificate.validFrom}`);
  }
  if (now.getTime() >= validTo) {
    throw new Error(`The TLS certificate expired at ${certificate.validTo}`);
  }
  if (!certificate.checkHost(serverName)) {
    throw new Error(`The TLS certificate does not cover TLS_SERVER_NAME ${serverName}`);
  }

  let privateKeyPublicKey: Buffer;
  try {
    privateKeyPublicKey = Buffer.from(
      createPublicKey(createPrivateKey(privateKeyPem)).export({
        format: "der",
        type: "spki",
      }),
    );
  } catch (error: unknown) {
    const reason = error instanceof Error ? error.message : "unknown error";
    throw new Error(`TLS_KEY_PATH does not contain a valid private key: ${reason}`);
  }

  const certificatePublicKey = Buffer.from(
    certificate.publicKey.export({ format: "der", type: "spki" }),
  );
  if (!certificatePublicKey.equals(privateKeyPublicKey)) {
    throw new Error("The TLS certificate and private key do not match");
  }
}

export function createDirectPublicServer(
  options: DirectServerOptions,
): HttpServer | HttpsServer {
  const environment = options.environment ?? process.env;
  validPort(options.port, "application port");
  const httpsEnabled = booleanValue(
    environment,
    options.httpsEnabledVariable,
    false,
  );
  if (!httpsEnabled) return createHttpServer(options.app);

  const certificatePath = requiredValue(environment, "TLS_CERT_PATH");
  const privateKeyPath = requiredValue(environment, "TLS_KEY_PATH");
  const serverName = requiredValue(environment, "TLS_SERVER_NAME");
  const certificate = readTlsFile(certificatePath, "TLS_CERT_PATH");
  const privateKey = readTlsFile(privateKeyPath, "TLS_KEY_PATH");
  validateCertificate(certificate, privateKey, serverName, options.now ?? new Date());

  return createHttpsServer({ cert: certificate, key: privateKey }, options.app);
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

export function startDirectServers(options: DirectServerOptions): StartedServers {
  const environment = options.environment ?? process.env;
  const host = environment.HOST?.trim() || "0.0.0.0";
  const publicServer = createDirectPublicServer(options);
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
    const protocol = booleanValue(
      environment,
      options.httpsEnabledVariable,
      false,
    )
      ? "https"
      : "http";
    console.log(`${options.label} listening on ${protocol}://${host}:${options.port}`);
  });

  return { publicServer, healthServer };
}
