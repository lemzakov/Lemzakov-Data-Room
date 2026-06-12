// Passkey (WebAuthn) registration & authentication, built on
// @simplewebauthn/server. This module owns the challenge lifecycle and the
// encoding between stored credentials (base64url strings in Redis) and the
// Uint8Array shapes the library expects.

const crypto = require('crypto');
const {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse
} = require('@simplewebauthn/server');

const { kvGet, kvSet, kvDel } = require('./storage');
const { getCredentials, addCredential, findCredential, updateCredentialCounter } = require('./users');

const CHALLENGE_TTL_SECONDS = 5 * 60;

function regChallengeKey(email) {
  return `challenge:reg:${email}`;
}
function authChallengeKey(email) {
  return `challenge:auth:${email}`;
}

// Stable, opaque WebAuthn user handle derived from the email so re-registering
// on the same authenticator updates the existing passkey instead of duplicating.
function userHandle(email) {
  return new Uint8Array(crypto.createHash('sha256').update(email).digest());
}

function b64urlToBytes(b64url) {
  return new Uint8Array(Buffer.from(b64url, 'base64url'));
}
function bytesToB64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

// ---- Registration ----

async function buildRegistrationOptions({ email, rpID, rpName }) {
  const existing = await getCredentials(email);
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userID: userHandle(email),
    userName: email,
    userDisplayName: email,
    attestationType: 'none',
    excludeCredentials: existing.map((c) => ({
      id: c.id,
      transports: c.transports
    })),
    authenticatorSelection: {
      residentKey: 'preferred',
      userVerification: 'preferred'
    }
  });
  await kvSet(regChallengeKey(email), options.challenge, CHALLENGE_TTL_SECONDS);
  return options;
}

async function verifyRegistration({ email, response, rpID, origin }) {
  const expectedChallenge = await kvGet(regChallengeKey(email));
  if (!expectedChallenge) {
    return { verified: false, error: 'challenge_expired' };
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false
    });
  } catch (error) {
    return { verified: false, error: error.message };
  } finally {
    await kvDel(regChallengeKey(email));
  }

  if (!verification.verified || !verification.registrationInfo) {
    return { verified: false, error: 'not_verified' };
  }

  const { credential } = verification.registrationInfo;
  await addCredential(email, {
    id: credential.id,
    publicKey: bytesToB64url(credential.publicKey),
    counter: credential.counter,
    transports: response.response?.transports || []
  });

  return { verified: true };
}

// ---- Authentication ----

async function buildAuthenticationOptions({ email, rpID }) {
  const creds = await getCredentials(email);
  const options = await generateAuthenticationOptions({
    rpID,
    userVerification: 'preferred',
    allowCredentials: creds.map((c) => ({
      id: c.id,
      transports: c.transports
    }))
  });
  await kvSet(authChallengeKey(email), options.challenge, CHALLENGE_TTL_SECONDS);
  return options;
}

async function verifyAuthentication({ email, response, rpID, origin }) {
  const expectedChallenge = await kvGet(authChallengeKey(email));
  if (!expectedChallenge) {
    return { verified: false, error: 'challenge_expired' };
  }

  const stored = await findCredential(email, response.id);
  if (!stored) {
    await kvDel(authChallengeKey(email));
    return { verified: false, error: 'unknown_credential' };
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge,
      expectedOrigin: origin,
      expectedRPID: rpID,
      requireUserVerification: false,
      credential: {
        id: stored.id,
        publicKey: b64urlToBytes(stored.publicKey),
        counter: stored.counter,
        transports: stored.transports
      }
    });
  } catch (error) {
    return { verified: false, error: error.message };
  } finally {
    await kvDel(authChallengeKey(email));
  }

  if (!verification.verified) {
    return { verified: false, error: 'not_verified' };
  }

  await updateCredentialCounter(email, stored.id, verification.authenticationInfo.newCounter);
  return { verified: true };
}

module.exports = {
  buildRegistrationOptions,
  verifyRegistration,
  buildAuthenticationOptions,
  verifyAuthentication,
  CHALLENGE_TTL_SECONDS
};
