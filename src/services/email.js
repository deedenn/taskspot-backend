import nodemailer from "nodemailer";

function smtpConfigured() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_FROM);
}

function createTransporter() {
  const port = Number(process.env.SMTP_PORT || 587);

  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port,
    secure: process.env.SMTP_SECURE === "true" || port === 465,
    requireTLS: process.env.SMTP_REQUIRE_TLS === "true",
    auth: process.env.SMTP_USER
      ? {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        }
      : undefined
  });
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

  const transporter = createTransporter();
  const info = await transporter.sendMail({
    from: process.env.SMTP_FROM,
    to,
    subject,
    text,
    html
  });

  return { skipped: false, messageId: info.messageId };
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
