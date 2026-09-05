import net from "node:net";
import nodemailer from "nodemailer";
import { enqueueEmail, safeEmailError } from "./emailQueue.js";

const EMAIL_LOG_PREFIX = "[taskspot:email]";

function smtpReadiness() {
  const requiredKeys = ["SMTP_HOST", "SMTP_FROM", "SMTP_USER", "SMTP_PASS"];
  const missing = requiredKeys.filter((key) => !process.env[key]);

  return { missing };
}

function smtpHost() {
  return String(process.env.SMTP_HOST || "").trim().toLowerCase();
}

function isTimewebSmtp() {
  return smtpHost() === "smtp.timeweb.ru";
}

function maskEmail(email) {
  const [local = "", domain = ""] = String(email || "").split("@");

  if (!domain) {
    return "***";
  }

  const visible = local.slice(0, 2);
  return `${visible}${local.length > 2 ? "***" : "*"}@${domain}`;
}

function smtpPublicConfig(options) {
  return {
    host: options.host,
    port: options.port,
    secure: options.secure,
    requireTLS: options.requireTLS,
    hasAuthUser: Boolean(options.auth?.user),
    hasAuthPass: Boolean(options.auth?.pass),
    from: process.env.SMTP_FROM || "",
    user: process.env.SMTP_USER || "",
    connectionTimeout: options.connectionTimeout,
    greetingTimeout: options.greetingTimeout,
    socketTimeout: options.socketTimeout
  };
}

function smtpWarnings() {
  const warnings = [];
  const from = String(process.env.SMTP_FROM || "");
  const fromEmail = from.match(/<([^>]+)>/)?.[1] || from;
  const smtpUser = String(process.env.SMTP_USER || "");

  if (fromEmail && smtpUser && fromEmail.toLowerCase() !== smtpUser.toLowerCase()) {
    warnings.push("SMTP_FROM email differs from SMTP_USER. Some SMTP providers reject this.");
  }

  if (isTimewebSmtp() && !configuredPorts().includes(2525)) {
    warnings.push("Timeweb SMTP often requires port 2525 when 465/587 are blocked.");
  }

  return warnings;
}

function logEmail(event, payload = {}, level = "info") {
  const line = {
    event,
    at: new Date().toISOString(),
    ...payload
  };

  console[level](`${EMAIL_LOG_PREFIX} ${JSON.stringify(line)}`);
}

function uniqNumbers(values) {
  return [...new Set(values.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0))];
}

function configuredPorts() {
  if (process.env.SMTP_PORTS) {
    return uniqNumbers(process.env.SMTP_PORTS.split(",").map((value) => value.trim()));
  }

  const primaryPort = Number(process.env.SMTP_PORT || 587);
  const fallbackPort = Number(process.env.SMTP_FALLBACK_PORT || 2525);

  if (isTimewebSmtp()) {
    return uniqNumbers([primaryPort, fallbackPort, 587, 465]);
  }

  return uniqNumbers([primaryPort, fallbackPort]);
}

function defaultSecurityForPort(port) {
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

function createTransportOptions(overrides = {}) {
  const port = Number(overrides.port || process.env.SMTP_PORT || 587);
  const security = defaultSecurityForPort(port);
  const secure = overrides.secure ?? security.secure;
  const requireTLS = overrides.requireTLS ?? security.requireTLS;

  return {
    host: smtpHost() || process.env.SMTP_HOST,
    port,
    secure,
    requireTLS,
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT_MS || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT_MS || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT_MS || 15000),
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  };
}

function createTransportProfiles() {
  return configuredPorts().map((port) => createTransportOptions({ port }));
}

function isRetryableSmtpError(error) {
  return ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code) ||
    ["CONN", "GREETING"].includes(error?.command);
}

function smtpErrorDetails(error) {
  return {
    error: safeEmailError(error),
    code: error?.code,
    command: error?.command,
    responseCode: error?.responseCode,
  };
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const sendMail = enqueueEmail;

export async function deliverMail({ to, subject, text, html, messageId }) {
  const readiness = smtpReadiness();

  if (readiness.missing.length) {
    logEmail("smtp_skipped", {
      reason: "SMTP is not configured",
      missingKeys: readiness.missing,
      to: maskEmail(to),
      subject
    }, "warn");
    throw Object.assign(new Error("SMTP is not configured"), { code: "SMTP_NOT_CONFIGURED" });
  }

  let lastError;
  const profiles = createTransportProfiles();

  logEmail("smtp_send_start", {
    to: maskEmail(to),
    subject,
    profiles: profiles.map(smtpPublicConfig)
  });

  for (const options of profiles) {
    try {
      logEmail("smtp_attempt", {
        to: maskEmail(to),
        subject,
        profile: smtpPublicConfig(options)
      });
      const transporter = nodemailer.createTransport(options);
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
        html,
        messageId
      });
      if (!info.accepted?.length) {
        throw Object.assign(new Error("Recipient rejected"), { code: "EENVELOPE", responseCode: 550 });
      }

      logEmail("smtp_sent", {
        to: maskEmail(to),
        subject,
        messageId: info.messageId,
        port: options.port
      });

      return { skipped: false, messageId: info.messageId, port: options.port };
    } catch (error) {
      lastError = error;

      logEmail("smtp_attempt_failed", {
        to: maskEmail(to),
        subject,
        profile: smtpPublicConfig(options),
        ...smtpErrorDetails(error),
        retryable: isRetryableSmtpError(error)
      }, "error");

      if (!isRetryableSmtpError(error)) {
        throw error;
      }
    }
  }

  logEmail("smtp_send_failed", {
    to: maskEmail(to),
    subject,
    ...smtpErrorDetails(lastError)
  }, "error");

  throw lastError;
}

function probeTcp({ host, port, timeout = 10000 }) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const socket = net.createConnection({ host, port, timeout }, () => {
      socket.destroy();
      resolve({ ok: true, ms: Date.now() - startedAt });
    });

    socket.on("timeout", () => {
      socket.destroy();
      resolve({ ok: false, ms: Date.now() - startedAt, error: "timeout" });
    });

    socket.on("error", (error) => {
      resolve({ ok: false, ms: Date.now() - startedAt, ...smtpErrorDetails(error) });
    });
  });
}

async function probeSmtp(options) {
  const startedAt = Date.now();

  try {
    const transporter = nodemailer.createTransport(options);
    await transporter.verify();
    return { ok: true, ms: Date.now() - startedAt };
  } catch (error) {
    return {
      ok: false,
      ms: Date.now() - startedAt,
      ...smtpErrorDetails(error)
    };
  }
}

export function emailRuntimeConfig() {
  const readiness = smtpReadiness();
  const profiles = createTransportProfiles();

  return {
    configured: readiness.missing.length === 0,
    missingKeys: readiness.missing,
    warnings: smtpWarnings(),
    profiles: profiles.map(smtpPublicConfig)
  };
}

export async function checkEmailTransport() {
  const config = emailRuntimeConfig();

  if (!config.configured) {
    return {
      ok: false,
      ...config,
      checks: []
    };
  }

  const checks = [];

  for (const options of createTransportProfiles()) {
    const profile = smtpPublicConfig(options);
    const tcp = await probeTcp({
      host: options.host,
      port: options.port,
      timeout: options.connectionTimeout
    });
    const smtp = tcp.ok ? await probeSmtp(options) : { ok: false, skipped: true, reason: "tcp_failed" };

    checks.push({ profile, tcp, smtp });
  }

  return {
    ok: checks.some((check) => check.smtp.ok),
    ...config,
    checks
  };
}

export async function sendProjectInvitationEmail({ email, projectName, inviterName, role, invitationUrl, context }) {
  const roleLabel = role === "admin" ? "администратор" : "участник";
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeUrl = escapeHtml(invitationUrl);

  return sendMail({
    to: email,
    subject: `Приглашение в проект ${projectName} в Taskspot`,
    text: [
      `${inviterName} приглашает вас в проект "${projectName}" в Taskspot.`,
      `Роль: ${roleLabel}.`,
      `Принять приглашение: ${invitationUrl}`
    ].join("\n\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #17202a;">
        <h2 style="margin: 0 0 12px;">Приглашение в Taskspot</h2>
        <p>${safeInviter} приглашает вас в проект <strong>${safeProject}</strong>.</p>
        <p>Роль: <strong>${roleLabel}</strong>.</p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f7a8c;color:#ffffff;text-decoration:none;">
            Принять приглашение
          </a>
        </p>
        <p style="color:#6b7a86;">Если кнопка не открывается, скопируйте ссылку: ${safeUrl}</p>
      </div>
    `
  }, context);
}

export async function sendProjectMemberAddedEmail({ email, projectName, inviterName, appUrl, context }) {
  const safeProject = escapeHtml(projectName);
  const safeInviter = escapeHtml(inviterName);
  const safeUrl = escapeHtml(appUrl);

  return sendMail({
    to: email,
    subject: `Вы добавлены в проект ${projectName} в Taskspot`,
    text: [
      `${inviterName} добавил вас в проект "${projectName}" в Taskspot.`,
      `Открыть Taskspot: ${appUrl}`
    ].join("\n\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #17202a;">
        <h2 style="margin: 0 0 12px;">Вы добавлены в проект</h2>
        <p>${safeInviter} добавил вас в проект <strong>${safeProject}</strong>.</p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f7a8c;color:#ffffff;text-decoration:none;">
            Открыть Taskspot
          </a>
        </p>
      </div>
    `
  }, context);
}

export async function sendEmailVerificationEmail({ email, name, verificationUrl, context }) {
  const safeName = escapeHtml(name || "пользователь");
  const safeUrl = escapeHtml(verificationUrl);

  return sendMail({
    to: email,
    subject: "Подтвердите регистрацию в Taskspot",
    text: [
      `Здравствуйте, ${name || "пользователь"}!`,
      "Подтвердите email, чтобы начать работу в Taskspot.",
      `Подтвердить регистрацию: ${verificationUrl}`,
      "Если вы не регистрировались в Taskspot, просто проигнорируйте это письмо."
    ].join("\n\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #17202a;">
        <h2 style="margin: 0 0 12px;">Подтверждение регистрации</h2>
        <p>Здравствуйте, ${safeName}!</p>
        <p>Подтвердите email, чтобы начать работу в <strong>Taskspot</strong>.</p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#2563eb;color:#ffffff;text-decoration:none;">
            Подтвердить email
          </a>
        </p>
        <p style="color:#6b7a86;">Если кнопка не открывается, скопируйте ссылку: ${safeUrl}</p>
        <p style="color:#6b7a86;">Если вы не регистрировались в Taskspot, просто проигнорируйте это письмо.</p>
      </div>
    `
  }, context);
}

export async function sendTaskNotificationEmail({ email, projectName, taskDescription, message, taskUrl, context }) {
  const safeProject = escapeHtml(projectName);
  const safeTask = escapeHtml(taskDescription);
  const safeMessage = escapeHtml(message);
  const safeUrl = escapeHtml(taskUrl);

  return sendMail({
    to: email,
    subject: `Taskspot: ${message}`,
    text: [
      message,
      `Проект: ${projectName}`,
      `Задача: ${taskDescription}`,
      `Открыть задачу: ${taskUrl}`
    ].join("\n\n"),
    html: `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #17202a;">
        <h2 style="margin: 0 0 12px;">${safeMessage}</h2>
        <p>Проект: <strong>${safeProject}</strong></p>
        <p>Задача: <strong>${safeTask}</strong></p>
        <p>
          <a href="${safeUrl}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#1f7a8c;color:#ffffff;text-decoration:none;">
            Открыть задачу
          </a>
        </p>
      </div>
    `
  }, context);
}
