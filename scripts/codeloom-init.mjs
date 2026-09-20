#!/usr/bin/env node
// Codeloom modification of Multica v0.5.0: initialize an isolated internal deployment.
import { randomBytes } from "node:crypto";
import { closeSync, fchmodSync, openSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";
import { parseArgs } from "node:util";

function composeCommand(envFile) {
  const quoted = `'${envFile.replaceAll("'", "'\\''")}'`;
  return `docker compose --project-name codeloom --env-file ${quoted} -f docker-compose.selfhost.yml -f docker-compose.selfhost.build.yml -f docker-compose.codeloom.yml up -d --build`;
}

const help = `Usage (run from the repository root):
  node scripts/codeloom-init.mjs --origin http://192.168.1.20:3100 --email teammate@example.com
  node scripts/codeloom-init.mjs --origin http://multica.internal:3100 --bind-address 192.168.1.20 --email teammate@example.com

Options:
  --origin         Required http(s) origin, without path, query, credentials, or fragment.
  --email          Required team email; comma-separated addresses are also accepted.
  --bind-address   Specific local IPv4; required for a domain origin (never 0.0.0.0).
  --backend-port   Direct backend/daemon host port (default: 8180).
  --output         New output file (default: .env.codeloom); never overwrites a file.
  --help           Show this help.

Writes fresh JWT, PostgreSQL, and VCS secrets with mode 0600. No existing env is read.
Requires Docker Compose >= 2.24.4. Build and start the source images explicitly:
  ${composeCommand(".env.codeloom")}

The frontend host port is taken from --origin (HTTP 80 / HTTPS 443 if omitted).
HTTPS needs your own TLS-terminating LAN reverse proxy; the containers serve HTTP.
Behind that proxy, edit FRONTEND_PORT to an unused internal port and forward to it.
Direct backend/daemon URLs always use HTTP on the origin hostname and backend port.
Restrict both published ports to the trusted LAN; Docker may bypass host firewalls.
No SMTP configured: upstream prints random verification codes in backend logs.
Configure SMTP in the generated env for routine team access; protect those logs.
WARNING: a same-user daemon has that user's full filesystem and command permissions.
Only enroll trusted machines/users; this deployment does not sandbox daemon execution.
Nothing is started automatically. Keep the generated env private and back up its keys.
Custom env paths should stay outside the repository or use its ignored .env.* names.
`;

function port(value, label) {
  if (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    throw new Error(`${label} must be a port from 1 to 65535`);
  }
  return String(Number(value));
}

try {
  const { values } = parseArgs({
    options: {
      origin: { type: "string" },
      email: { type: "string" },
      "bind-address": { type: "string" },
      "backend-port": { type: "string", default: "8180" },
      output: { type: "string", default: ".env.codeloom" },
      help: { type: "boolean", short: "h" },
    },
    allowPositionals: false,
  });
  if (values.help) {
    console.log(help);
  } else {
    // Reject forbidden syntax before URL normalization can erase it (e.g. /..).
    if (!values.origin || !/^https?:\/\/[^/?#@\\\s]+\/?$/.test(values.origin)) {
      throw new Error("--origin must be an http(s) origin without path, query, credentials, or fragment");
    }
    const origin = new URL(values.origin);
    if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) {
      throw new Error("--origin must contain only a scheme, hostname, and optional port");
    }
    if (origin.hostname.includes(":")) {
      throw new Error("IPv6 origins are not supported; use an IPv4 address or domain");
    }
    const bindAddress = values["bind-address"] ?? (isIPv4(origin.hostname) ? origin.hostname : "");
    const firstOctet = Number(bindAddress.split(".")[0]);
    if (!isIPv4(bindAddress) || firstOctet === 0 || firstOctet >= 224) {
      throw new Error("--bind-address must be a specific local unicast IPv4 address; domains require it explicitly");
    }
    const frontendPort = port(origin.port || (origin.protocol === "https:" ? "443" : "80"), "Frontend port");
    if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(origin.hostname)) {
      throw new Error("--origin must use a valid IPv4 address or DNS hostname");
    }
    const backendPort = port(values["backend-port"], "--backend-port");
    if (frontendPort === backendPort) {
      throw new Error("Frontend and backend ports must differ on the shared bind address");
    }
    const emails = (values.email ?? "").split(",").map((email) => email.trim().toLowerCase());
    if (emails.some((email) => !/^[a-z0-9._%+-]+@[a-z0-9]+(?:[.-][a-z0-9]+)*$/.test(email))) {
      throw new Error("--email must contain one or more comma-separated team email addresses");
    }
    const envFile = values.output;
    if (!envFile || /[\r\n\0]/.test(envFile)) {
      throw new Error("--output must be a nonempty filename without control characters");
    }
    const content = `# Codeloom modification of Multica v0.5.0; generated private configuration.
# Do not commit or share. Back up these keys alongside the database.
# Keep PUBLIC_HOST and FRONTEND_PORT in sync with CODELOOM_PUBLIC_ORIGIN when editing.
# Namespaced to avoid the original Codeloom's inherited PUBLIC_ORIGIN.
CODELOOM_PUBLIC_ORIGIN=${origin.origin}
PUBLIC_HOST=${origin.hostname}
BIND_ADDRESS=${bindAddress}
FRONTEND_PORT=${frontendPort}
BACKEND_PORT=${backendPort}
ALLOWED_EMAILS=${emails.join(",")}
POSTGRES_DB=multica
POSTGRES_USER=multica
POSTGRES_PASSWORD=${randomBytes(32).toString("hex")}
JWT_SECRET=${randomBytes(32).toString("hex")}
MULTICA_VCS_SECRET_KEY=${randomBytes(32).toString("base64")}

# Optional internal SMTP. Without it, random verification codes appear in backend logs.
# Production mode is forced by Compose; fixed development codes are disabled.
SMTP_HOST=
SMTP_PORT=587
SMTP_USERNAME=
SMTP_PASSWORD=
SMTP_FROM_EMAIL=
SMTP_TLS=starttls
SMTP_TLS_INSECURE=false
`;
    // Exclusive creation also refuses symlinks, rather than following an old env file.
    const fd = openSync(envFile, "wx", 0o600);
    try {
      fchmodSync(fd, 0o600);
      writeFileSync(fd, content, "utf8");
    } finally {
      closeSync(fd);
    }
    console.log(`Created ${envFile} with mode 0600. No services started.\n\n${composeCommand(envFile)}\n\nWARNING: a same-user daemon has that user's full filesystem and command permissions.\nOnly enroll trusted users/machines. Protect backend logs: without SMTP they contain random login codes.`);
  }
} catch (error) {
  console.error(`codeloom-init: ${error.code === "EEXIST" ? "Refusing to overwrite an existing env file" : error.message}`);
  process.exitCode = 1;
}
