// Email one-time codes that prove control of an email address before a passkey
// is bound to it.
//
// Flow:
//   1. request: generate a 6-digit code, store only its hash at `otp:<email>`
//      (10 min TTL), email the code to the user.
//   2. verify: compare the submitted code to the stored hash. On success we set
//      a short-lived registration ticket `regticket:<email>` (10 min) that
//      authorizes passkey registration for that email.
//
// Codes are single-purpose and rate-limited to blunt guessing/abuse.

const crypto = require('crypto');
const { kvGet, kvSet, kvDel, kvGetJson, kvSetJson } = require('./storage');

const OTP_TTL_SECONDS = 10 * 60;
const TICKET_TTL_SECONDS = 10 * 60;
const MAX_ATTEMPTS = 5;
const RESEND_COOLDOWN_SECONDS = 30;
const MAX_PER_HOUR = 5;

function otpKey(email) {
  return `otp:${email}`;
}
function ticketKey(email) {
  return `regticket:${email}`;
}
function rateKey(email) {
  return `otprate:${email}`;
}

function generateCode() {
  // 6 digits, uniformly distributed, leading zeros preserved.
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

function hashCode(code, email) {
  return crypto.createHash('sha256').update(`${email}:${code}`).digest('hex');
}

// Best-effort per-email rate limiting. Returns { allowed, retryAfter }.
async function checkRateLimit(email) {
  const existing = (await kvGetJson(rateKey(email))) || { count: 0, windowStart: Date.now() };
  const now = Date.now();
  const last = await kvGet(`otplast:${email}`);
  if (last && now - Number(last) < RESEND_COOLDOWN_SECONDS * 1000) {
    return { allowed: false, retryAfter: RESEND_COOLDOWN_SECONDS };
  }
  if (existing.count >= MAX_PER_HOUR) {
    return { allowed: false, retryAfter: 3600 };
  }
  return { allowed: true };
}

async function recordSend(email) {
  const now = Date.now();
  const existing = (await kvGetJson(rateKey(email))) || { count: 0 };
  await kvSetJson(rateKey(email), { count: (existing.count || 0) + 1 }, 3600);
  await kvSet(`otplast:${email}`, String(now), RESEND_COOLDOWN_SECONDS);
}

// Creates and stores a code; returns the plaintext so the caller can email it.
async function issueCode(email) {
  const code = generateCode();
  await kvSetJson(
    otpKey(email),
    { hash: hashCode(code, email), attempts: 0 },
    OTP_TTL_SECONDS
  );
  await recordSend(email);
  return code;
}

// Returns { ok, reason }. On success, mints a registration ticket.
async function verifyCode(email, code) {
  const record = await kvGetJson(otpKey(email));
  if (!record) return { ok: false, reason: 'expired' };
  if (record.attempts >= MAX_ATTEMPTS) {
    await kvDel(otpKey(email));
    return { ok: false, reason: 'too_many_attempts' };
  }

  const submitted = hashCode(String(code || '').trim(), email);
  const expected = record.hash;
  const match =
    submitted.length === expected.length &&
    crypto.timingSafeEqual(Buffer.from(submitted), Buffer.from(expected));

  if (!match) {
    await kvSetJson(
      otpKey(email),
      { ...record, attempts: record.attempts + 1 },
      OTP_TTL_SECONDS
    );
    return { ok: false, reason: 'invalid' };
  }

  await kvDel(otpKey(email));
  await kvSet(ticketKey(email), '1', TICKET_TTL_SECONDS);
  return { ok: true };
}

async function hasRegistrationTicket(email) {
  return (await kvGet(ticketKey(email))) === '1';
}

async function consumeRegistrationTicket(email) {
  await kvDel(ticketKey(email));
}

module.exports = {
  OTP_TTL_SECONDS,
  MAX_ATTEMPTS,
  generateCode,
  hashCode,
  checkRateLimit,
  issueCode,
  verifyCode,
  hasRegistrationTicket,
  consumeRegistrationTicket
};
