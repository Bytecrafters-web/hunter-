const nodemailer = require('nodemailer');
require('dotenv').config();

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: false,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS
  }
});

function buildEmailTemplate(lead) {
  const niceName = lead.name || 'there';
  const service = lead.source !== 'upwork'
    ? 'a modern website + WhatsApp order/booking bot'
    : 'web & automation development';

  const subject = `Quick idea for ${niceName} - website + WhatsApp automation`;

  const text = `Assalam o Alaikum,

I came across "${niceName}"${lead.city ? ` in ${lead.city}` : ''} and noticed there might be room to grow online with ${service}.

I'm Rauf, a full-stack developer (8+ years) who builds:
- Fast, modern business websites
- WhatsApp bots for automated bookings/orders/customer support
- Simple admin dashboards to manage everything

If you're open to it, I'd love to share a few quick ideas specific to your business - no obligation, just a short chat or a free mockup.

Best,
Rauf
Software Developer | KDA
`;

  return { subject, text };
}

async function sendEmail(lead) {
  const { subject, text } = buildEmailTemplate(lead);
  return transporter.sendMail({
    from: `"${process.env.SMTP_FROM_NAME || 'Rauf'}" <${process.env.SMTP_USER}>`,
    to: lead.email,
    subject,
    text
  });
}

module.exports = { sendEmail, buildEmailTemplate };
