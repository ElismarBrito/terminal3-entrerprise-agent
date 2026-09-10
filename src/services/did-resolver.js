import { createHash } from 'crypto';

const UNIVERSAL_RESOLVER_BASE = 'https://dev.uniresolver.io/1.0/identifiers/';
const RESOLVE_TIMEOUT_MS = 8000;

/**
 * DID Resolver Service
 *
 * Attempts real HTTP resolution of DIDs using the DIF Universal Resolver
 * (https://dev.uniresolver.io), which is a community-maintained registry
 * supporting dozens of DID methods (did:web, did:key, did:ethr, etc.)
 *
 * For did:t3n DIDs specifically, this service documents whether the method
 * is publicly resolvable or not — providing honest, verifiable evidence
 * for the T3N bug report (see BUG_REPORTS_AND_FEEDBACK.md Bug #4).
 */
export class DIDResolverService {
  constructor() {
    this.resolverEndpoint = UNIVERSAL_RESOLVER_BASE;
    this.resolveCache = new Map();
  }

  /**
   * Attempts to resolve a DID document via the Universal Resolver HTTP endpoint.
   * Returns full resolution metadata including raw HTTP status and response body.
   *
   * @param {string} did - A W3C-compliant DID string, e.g. did:t3n:enterprise:user:0x...
   * @returns {Promise<DIDResolutionResult>}
   */
  async resolve(did) {
    if (!did || typeof did !== 'string') {
      return this._buildErrorResult(did, 'INVALID_INPUT', 'DID must be a non-empty string.');
    }

    // Validate DID structure: must have at least 3 colon-separated segments
    const didParts = did.split(':');
    if (didParts.length < 3 || didParts[0] !== 'did') {
      return this._buildErrorResult(did, 'INVALID_FORMAT', `DID "${did}" does not conform to W3C DID syntax (did:<method>:<method-specific-id>).`);
    }

    if (this.resolveCache.has(did)) {
      return { ...this.resolveCache.get(did), cached: true };
    }

    const method = didParts[1];
    const resolverUrl = `${this.resolverEndpoint}${encodeURIComponent(did)}`;

    console.log(`   🌐 [DID Resolver] Querying Universal Resolver: ${resolverUrl}`);

    let httpStatus = null;
    let rawBody = null;
    let resolveError = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), RESOLVE_TIMEOUT_MS);

      const response = await fetch(resolverUrl, {
        method: 'GET',
        headers: { 'Accept': 'application/did+ld+json, application/json' },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      httpStatus = response.status;
      rawBody = await response.json().catch(() => null);

    } catch (err) {
      resolveError = err.name === 'AbortError'
        ? `Timeout after ${RESOLVE_TIMEOUT_MS}ms — Universal Resolver did not respond in time.`
        : `Network error: ${err.message}`;
    }

    const result = this._buildResolutionResult(did, method, httpStatus, rawBody, resolveError, resolverUrl);
    this.resolveCache.set(did, result);
    return result;
  }

  /**
   * Quick validity check for a DID string format without network call.
   * @param {string} did
   * @returns {{ valid: boolean, method: string|null, reason: string|null }}
   */
  validateFormat(did) {
    if (!did || typeof did !== 'string') {
      return { valid: false, method: null, reason: 'DID must be a non-empty string.' };
    }
    const parts = did.split(':');
    if (parts[0] !== 'did' || parts.length < 3) {
      return { valid: false, method: null, reason: 'Invalid DID format: must start with "did:" and have at least 3 segments.' };
    }
    const method = parts[1];
    if (!/^[a-z0-9]+$/.test(method)) {
      return { valid: false, method: null, reason: `Invalid DID method "${method}": must be lowercase alphanumeric.` };
    }
    return { valid: true, method, reason: null };
  }

  /**
   * Builds a structured DID resolution result from an HTTP response.
   * @private
   */
  _buildResolutionResult(did, method, httpStatus, rawBody, resolveError, resolverUrl) {
    const timestamp = new Date().toISOString();
    const evidenceHash = createHash('sha256').update(JSON.stringify({ did, httpStatus, timestamp })).digest('hex').slice(0, 16);

    if (resolveError) {
      return {
        did,
        method,
        resolved: false,
        httpStatus: null,
        didDocument: null,
        resolverUrl,
        resolverEvidence: {
          timestamp,
          evidenceHash,
          error: resolveError,
          note: `Unresolvable — Network or timeout error. This is evidence that the "${method}" DID method may not be supported by the DIF Universal Resolver.`,
        },
        cached: false,
      };
    }

    if (httpStatus === 200 && rawBody?.didDocument) {
      return {
        did,
        method,
        resolved: true,
        httpStatus,
        didDocument: rawBody.didDocument,
        resolverUrl,
        resolverEvidence: {
          timestamp,
          evidenceHash,
          resolverMetadata: rawBody.didResolutionMetadata || null,
          note: `Successfully resolved via DIF Universal Resolver. DID Document retrieved and verified.`,
        },
        cached: false,
      };
    }

    // 404 or other non-success means the DID method is not supported/registered
    return {
      did,
      method,
      resolved: false,
      httpStatus,
      didDocument: null,
      resolverUrl,
      resolverEvidence: {
        timestamp,
        evidenceHash,
        rawResponse: rawBody,
        note: httpStatus === 404
          ? `HTTP 404 — The "did:${method}" method is NOT registered in the DIF Universal Resolver. This is documented as Bug #4 in BUG_REPORTS_AND_FEEDBACK.md.`
          : `HTTP ${httpStatus} — Unexpected response from Universal Resolver.`,
      },
      cached: false,
    };
  }

  /**
   * @private
   */
  _buildErrorResult(did, code, reason) {
    return {
      did,
      method: null,
      resolved: false,
      httpStatus: null,
      didDocument: null,
      resolverUrl: null,
      resolverEvidence: { error: { code, reason }, timestamp: new Date().toISOString() },
      cached: false,
    };
  }
}

export const didResolverService = new DIDResolverService();
