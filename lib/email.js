// Transactional email via the Resend HTTP API (https://resend.com).
//
// Requires two env vars:
//   RESEND_API_KEY  - the Resend API key
//   EMAIL_FROM      - a verified sender, e.g. "Data Room <auth@yourdomain.com>"
//
// In development, if RESEND_API_KEY is unset we log the message instead of
// sending so the flow can be exercised without a provider.

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

function isConfigured() {
  return Boolean(process.env.RESEND_API_KEY && process.env.EMAIL_FROM);
}

async function sendEmail({ to, subject, html, text }, options = {}) {
  const { fetchImpl = fetch, logger = console } = options;

  if (!isConfigured()) {
    logger.warn('[email] RESEND_API_KEY/EMAIL_FROM not set — logging instead of sending', {
      to,
      subject,
      text
    });
    return { ok: true, simulated: true };
  }

  const response = await fetchImpl(RESEND_ENDPOINT, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: process.env.EMAIL_FROM,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    logger.error('[email] Resend send failed', { status: response.status, body: body.slice(0, 300) });
    throw new Error(`Email send failed: ${response.status}`);
  }

  return { ok: true };
}

function renderOtpEmail({ code, appName = 'Lemzakov Data Room', ttlMinutes = 10 }) {
  const subject = `Your ${appName} verification code: ${code}`;
  const text = `Your ${appName} verification code is ${code}. It expires in ${ttlMinutes} minutes. If you didn't request this, you can ignore this email.`;
  const html = `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#111;max-width:480px;margin:0 auto;padding:24px">
  <h2 style="margin:0 0 12px">${appName}</h2>
  <p style="margin:0 0 16px">Use this code to verify your email and set up access:</p>
  <p style="font-size:32px;font-weight:700;letter-spacing:6px;margin:0 0 16px">${code}</p>
  <p style="color:#555;font-size:14px;margin:0">This code expires in ${ttlMinutes} minutes. If you didn't request it, ignore this email.</p>
</body></html>`;
  return { subject, text, html };
}

module.exports = { isConfigured, sendEmail, renderOtpEmail };
