import nodemailer from "nodemailer";
import { config } from "./config.js";

function createTransport() {
  if (!config.smtp.user || !config.smtp.pass) {
    // No SMTP configured — log to console in dev
    return null;
  }
  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: { user: config.smtp.user, pass: config.smtp.pass },
  });
}

interface MailOptions {
  to: string;
  subject: string;
  html: string;
}

export async function sendMail(opts: MailOptions): Promise<void> {
  const transport = createTransport();
  if (!transport) {
    // Dev fallback: print to console
    console.log(`\n📧 [MAIL — no SMTP configured]\nTo: ${opts.to}\nSubject: ${opts.subject}\n${opts.html.replace(/<[^>]+>/g, "")}\n`);
    return;
  }
  await transport.sendMail({
    from: `"Parul University" <${config.smtp.from}>`,
    to: opts.to,
    subject: opts.subject,
    html: opts.html,
  });
}

export function passwordResetEmail(name: string, resetUrl: string): string {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
      <h2 style="color:#1a1a1a">Password Reset</h2>
      <p>Hi ${name || "there"},</p>
      <p>You requested a password reset for your Parul University Knowledge Hub account.</p>
      <p>
        <a href="${resetUrl}" style="display:inline-block;padding:10px 20px;background:#e91e8c;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Reset Password
        </a>
      </p>
      <p style="color:#666;font-size:13px">This link expires in <strong>30 minutes</strong>. If you didn't request this, ignore this email.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Parul University Knowledge Hub</p>
    </div>`;
}

export function emailVerificationMail(name: string, verifyUrl: string): string {
  return `
    <div style="font-family:sans-serif;max-width:480px;margin:auto;padding:24px">
      <h2 style="color:#1a1a1a">Verify Your Email</h2>
      <p>Hi ${name || "there"},</p>
      <p>Please verify your email address for your Parul University Knowledge Hub account.</p>
      <p>
        <a href="${verifyUrl}" style="display:inline-block;padding:10px 20px;background:#e91e8c;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">
          Verify Email
        </a>
      </p>
      <p style="color:#666;font-size:13px">This link expires in <strong>24 hours</strong>.</p>
      <hr style="border:none;border-top:1px solid #eee;margin:24px 0">
      <p style="color:#999;font-size:12px">Parul University Knowledge Hub</p>
    </div>`;
}
