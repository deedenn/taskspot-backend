import dotenv from "dotenv";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import nodemailer from "nodemailer";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

dotenv.config({ path: path.join(rootDir, ".env") });

if (process.env.NODE_ENV !== "production") {
  dotenv.config({ path: path.join(rootDir, ".env.local"), override: true });
}

function uniqNumbers(values) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

function smtpHost() {
  return String(process.env.SMTP_HOST || "").trim().toLowerCase();
}

function smtpPorts() {
  if (process.env.SMTP_PORTS) {
    return uniqNumbers(process.env.SMTP_PORTS.split(",").map((value) => value.trim()));
  }

  const primaryPort = Number(process.env.SMTP_PORT || 587);
  const fallbackPort = Number(process.env.SMTP_FALLBACK_PORT || 2525);
  const defaults = smtpHost() === "smtp.timeweb.ru" ? [primaryPort, fallbackPort, 587, 465] : [primaryPort, fallbackPort];

  return uniqNumbers(defaults);
}

function securityForPort(port) {
  if (port === 465) {
    return { secure: true, requireTLS: false };
  }

  if (port === 587 || port === 2525) {
    return { secure: false, requireTLS: true };
  }

  return {
    secure: process.env.SMTP_SECURE === "true",
    requireTLS: process.env.SMTP_REQUIRE_TLS === "true"
  };
}

function publicConfig(port) {
  const security = securityForPort(port);

  return {
    host: smtpHost(),
    port,
    secure: security.secure,
    requireTLS: security.requireTLS,
    hasAuthUser: Boolean(process.env.SMTP_USER),
    hasAuthPass: Boolean(process.env.SMTP_PASS),
    from: process.env.SMTP_FROM || ""
  };
}

function probeTcp({ host, port }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port, timeout: 10000 }, () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - startedAt });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error: "timeout" });
    });

    socket.on("error", (error) => {
      resolve({ ok: false, ms: Date.now() - startedAt, error: error.code || error.message });
    });
  });
}

async function probeSmtp(config) {
  const startedAt = Date.now();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    requireTLS: config.requireTLS,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });

  try {
    await transporter.verify();
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      error: error.message,
      code: error.code,
      command: error.command,
      responseCode: error.responseCode
    };
  }
}

async function main() {
  const host = smtpHost();

  if (!host) {
    console.error(JSON.stringify({ ok: false, error: "SMTP_HOST is not set" }, null, 2));
    process.exitCode = 1;
    return;
  }

  const ports = smtpPorts();
  console.log(JSON.stringify({
    event: "smtp_check_start",
    nodeEnv: process.env.NODE_ENV || "",
    host,
    ports,
    hasAuthUser: Boolean(process.env.SMTP_USER),
    hasAuthPass: Boolean(process.env.SMTP_PASS),
    from: process.env.SMTP_FROM || ""
  }, null, 2));

  for (const port of ports) {
    const config = publicConfig(port);
    const tcp = await probeTcp(config);
    const smtp = tcp.ok ? await probeSmtp(config) : { ok: false, skipped: true, reason: "tcp_failed" };

    console.log(JSON.stringify({
      event: "smtp_check_port",
      profile: config,
      tcp,
      smtp
    }, null, 2));
  }
}

await main();
