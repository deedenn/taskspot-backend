import nodemailer from "nodemailer";

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function createTransportOptions(overrides = {}) {
  const port = Number(overrides.port || process.env.SMTP_PORT || 587);
  const secure = overrides.secure ?? (process.env.SMTP_SECURE === "true" || port === 465);
  const requireTLS = overrides.requireTLS ?? process.env.SMTP_REQUIRE_TLS === "true";

  return {
    host: process.env.SMTP_HOST,
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
  const primaryPort = Number(process.env.SMTP_PORT || 587);
  const profiles = [createTransportOptions()];
  const fallbackPort = Number(process.env.SMTP_FALLBACK_PORT || 2525);
  const isTimewebSmtp = process.env.SMTP_HOST === "smtp.timeweb.ru";

  if (isTimewebSmtp && primaryPort !== fallbackPort) {
    profiles.push(createTransportOptions({ port: fallbackPort, secure: false, requireTLS: true }));
  }

  return profiles;
}

function isRetryableSmtpError(error) {
  return ["ETIMEDOUT", "ECONNECTION", "ESOCKET", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN"].includes(error?.code) ||
    ["CONN", "GREETING"].includes(error?.command);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function sendMail({ to, subject, text, html }) {
  if (!smtpConfigured()) {
    return { skipped: true, reason: "SMTP is not configured" };
  }

  let lastError;

  for (const options of createTransportProfiles()) {
    try {
      const transporter = nodemailer.createTransport(options);
      const info = await transporter.sendMail({
        from: process.env.SMTP_FROM,
        to,
        subject,
        text,
        html
      });

      return { skipped: false, messageId: info.messageId, port: options.port };
    } catch (error) {
      lastError = error;

      if (!isRetryableSmtpError(error)) {
        throw error;
      }
    }
  }

  throw lastError;
}

export async function sendProjectInvitationEmail({ email, projectName, inviterName, role, invitationUrl }) {
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
  });
}

export async function sendProjectMemberAddedEmail({ email, projectName, inviterName, appUrl }) {
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
  });
}

export async function sendTaskNotificationEmail({ email, projectName, taskDescription, message, taskUrl }) {
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
  });
}
