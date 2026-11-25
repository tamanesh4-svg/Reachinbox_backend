
import nodemailer from "nodemailer";
import { env } from "../config/env";

export async function sendWithEthereal(input: {
  from: string;
  to: string;
  subject: string;
  text: string;
  smtpUser: string;
  smtpPassword: string;
}) {
  const transporter = nodemailer.createTransport({
    host: env.etherealHost,
    port: env.etherealPort,
    secure: env.etherealPort === 465,

    auth: {
      user: input.smtpUser,
      pass: input.smtpPassword
    },

    // Prevent SMTP connections from hanging indefinitely.
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 30000
  });

  try {
    const info = await transporter.sendMail({
      from: input.from,
      to: input.to,
      subject: input.subject,
      text: input.text
    });

    return {
      messageId: info.messageId,
      previewUrl: nodemailer.getTestMessageUrl(info) || null
    };
  } finally {
    transporter.close();
  }
}
