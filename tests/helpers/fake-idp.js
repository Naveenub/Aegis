/**
 * Loopback OpenID Connect provider for tests: discovery, JWKS and a token
 * endpoint that returns an ID token signed with a throwaway RS256 key.
 * (jose's remote JWKS fetch uses node http, so this must be a real server.)
 */
import http from 'http';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';

export async function startFakeIdp({ clientId = 'cid' } = {}) {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  const state = { claims: {}, nonce: null, tokenStatus: 200, lastTokenBody: null, signWith: privateKey };

  const server = http.createServer(async (req, res) => {
    const send = (code, body) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/.well-known/openid-configuration') {
      return send(200, {
        issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      });
    }
    if (u.pathname === '/jwks') return send(200, { keys: [jwk] });
    if (u.pathname === '/token') {
      let body = '';
      for await (const chunk of req) body += chunk;
      state.lastTokenBody = Object.fromEntries(new URLSearchParams(body));
      if (state.tokenStatus !== 200) return send(state.tokenStatus, { error: 'invalid_grant' });
      const idToken = await new SignJWT({ nonce: state.nonce, ...state.claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'k1' })
        .setIssuer(issuer).setAudience(clientId).setIssuedAt().setExpirationTime('5m')
        .sign(state.signWith);
      return send(200, { id_token: idToken, access_token: 'at' });
    }
    send(404, {});
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const issuer = `http://127.0.0.1:${server.address().port}`;

  return {
    issuer, clientId, state,
    /** Claims the next ID token will carry (sub/email/…); nonce is taken from the authorize URL. */
    willIssue(claims, authorizeUrl) {
      state.claims = claims;
      state.nonce = new URL(authorizeUrl).searchParams.get('nonce');
    },
    async signWithOtherKey() { state.signWith = (await generateKeyPair('RS256')).privateKey; },
    close: () => new Promise((r) => server.close(r)),
  };
}
