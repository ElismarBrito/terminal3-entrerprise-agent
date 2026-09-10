import { ethers } from 'ethers';
import { createHash } from 'crypto';
import { config } from '../config.js';

const RESOLVE_TIMEOUT_MS = 8000;

/**
 * T3N DID Method Schema
 *
 * The canonical did:t3n format (per Terminal 3 documentation):
 *   did:t3n:<realm>:<role>:<0xEthereumAddress>
 *
 * Where:
 *   realm ∈ { enterprise, user, node, agent }
 *   role  ∈ { audit, user, agent, validator, relay, service }
 *   address = a valid checksummed Ethereum address (0x + 40 hex chars)
 *
 * Example: did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC
 *
 * NOTE: Any did:t3n DID that does not match this exact schema is rejected,
 * even if it passes generic W3C DID format validation.
 */
const T3N_DID_SCHEMA = {
  method: 't3n',
  allowedRealms: new Set(['enterprise', 'user', 'node', 'agent']),
  allowedRoles:  new Set(['audit', 'user', 'agent', 'validator', 'relay', 'service']),
  // Full regex: did:t3n:<realm>:<role>:<0x + 40 hex chars>
  strictRegex: /^did:t3n:(enterprise|user|node|agent):(audit|user|agent|validator|relay|service):(0x[0-9a-fA-F]{40})$/,
};

/**
 * DID Resolver Service
 *
 * Two-layer DID validation:
 * 1. STRICT FORMAT — For did:t3n, enforces the full canonical schema.
 *    Generic W3C format is NOT sufficient. did:t3n:anything is REJECTED.
 * 2. NETWORK RESOLUTION — Real HTTP call to DIF Universal Resolver.
 *    HTTP 501 for did:t3n is captured as Bug #4 evidence.
 */
export class DIDResolverService {
  constructor() {
    this.resolverEndpoint = config.agent.didResolverUrl;
    this.resolveCache = new Map();
  }

  /**
   * Attempts to resolve a DID via the Universal Resolver HTTP endpoint.
   *
   * @param {string} did
   * @returns {Promise<DIDResolutionResult>}
   */
  async resolve(did) {
    if (!did || typeof did !== 'string') {
      return this._buildErrorResult(did, 'INVALID_INPUT', 'DID must be a non-empty string.');
    }

    const formatCheck = this.validateFormat(did);
    if (!formatCheck.valid) {
      return this._buildErrorResult(did, 'INVALID_FORMAT', formatCheck.reason);
    }

    if (this.resolveCache.has(did)) {
      return { ...this.resolveCache.get(did), cached: true };
    }

    const method = formatCheck.method;
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
        headers: { Accept: 'application/did+ld+json, application/json' },
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
   * Validates DID format with method-specific strictness.
   *
   * For did:t3n: enforces the full canonical schema (realm + role + ETH address).
   * For other methods: standard W3C DID syntax check.
   *
   * @param {string} did
   * @returns {{ valid: boolean, method: string|null, reason: string|null, t3nParsed?: object }}
   */
  validateFormat(did) {
    if (!did || typeof did !== 'string') {
      return { valid: false, method: null, reason: 'DID must be a non-empty string.' };
    }

    const parts = did.split(':');

    // Basic W3C structure: did:<method>:<method-specific-id>
    if (parts[0] !== 'did' || parts.length < 3) {
      return { valid: false, method: null, reason: `Invalid DID format: must be "did:<method>:<id>", got "${did}".` };
    }

    const method = parts[1];

    if (!/^[a-z0-9]+$/.test(method)) {
      return { valid: false, method: null, reason: `DID method "${method}" must be lowercase alphanumeric.` };
    }

    // ── Strict validation for did:t3n ────────────────────────────────────────
    if (method === T3N_DID_SCHEMA.method) {
      return this._validateT3nDid(did, parts);
    }

    // ── Generic W3C validation for other methods ──────────────────────────────
    if (parts.length < 3 || !parts[2]) {
      return { valid: false, method, reason: `DID method-specific ID is empty.` };
    }

    return { valid: true, method, reason: null };
  }

  /**
   * Enforces the strict did:t3n schema:
   *   did:t3n:<realm>:<role>:<0xAddress>
   * @private
   */
  _validateT3nDid(did, parts) {
    // Must have exactly 5 segments: did, t3n, realm, role, address
    if (parts.length !== 5) {
      return {
        valid: false,
        method: 't3n',
        reason: `did:t3n requires exactly 5 colon-separated segments: did:t3n:<realm>:<role>:<0xAddress>. Got ${parts.length} segment(s) in "${did}".`,
      };
    }

    const [, , realm, role, address] = parts;

    if (!T3N_DID_SCHEMA.allowedRealms.has(realm)) {
      return {
        valid: false,
        method: 't3n',
        reason: `Invalid did:t3n realm "${realm}". Allowed: ${[...T3N_DID_SCHEMA.allowedRealms].join(', ')}.`,
      };
    }

    if (!T3N_DID_SCHEMA.allowedRoles.has(role)) {
      return {
        valid: false,
        method: 't3n',
        reason: `Invalid did:t3n role "${role}". Allowed: ${[...T3N_DID_SCHEMA.allowedRoles].join(', ')}.`,
      };
    }

    // Accept both lowercase and checksummed ETH addresses;
    // normalize via ethers.getAddress() (EIP-55 checksum).
    // ethers.isAddress() returns true for valid hex addresses regardless of case.
    if (!address || !address.startsWith('0x') || !ethers.isAddress(address)) {
      return {
        valid: false,
        method: 't3n',
        reason: `Invalid did:t3n address "${address}". Must be a valid Ethereum address (0x + 40 hex chars).`,
      };
    }

    const normalizedAddress = ethers.getAddress(address); // EIP-55 checksum normalization

    if (!T3N_DID_SCHEMA.strictRegex.test(did.replace(address, normalizedAddress)) &&
        !T3N_DID_SCHEMA.strictRegex.test(did)) {
      return {
        valid: false,
        method: 't3n',
        reason: `DID "${did}" does not match the canonical did:t3n schema.`,
      };
    }

    return {
      valid: true,
      method: 't3n',
      reason: null,
      t3nParsed: {
        realm,
        role,
        address: normalizedAddress, // always stored in EIP-55 checksum form
      },
    };
  }

  /**
   * @private
   */
  _buildResolutionResult(did, method, httpStatus, rawBody, resolveError, resolverUrl) {
    const timestamp = new Date().toISOString();
    const evidenceHash = createHash('sha256')
      .update(JSON.stringify({ did, httpStatus, timestamp }))
      .digest('hex')
      .slice(0, 16);

    if (resolveError) {
      return {
        did, method, resolved: false, httpStatus: null, didDocument: null, resolverUrl,
        resolverEvidence: { timestamp, evidenceHash, error: resolveError,
          note: `Unresolvable — network or timeout. The "${method}" DID method may not be supported by the DIF Universal Resolver.` },
        cached: false,
      };
    }

    if (httpStatus === 200 && rawBody?.didDocument) {
      return {
        did, method, resolved: true, httpStatus, didDocument: rawBody.didDocument, resolverUrl,
        resolverEvidence: { timestamp, evidenceHash, resolverMetadata: rawBody.didResolutionMetadata || null,
          note: `Successfully resolved via DIF Universal Resolver.` },
        cached: false,
      };
    }

    const noteMap = {
      404: `HTTP 404 — "did:${method}" method not found in DIF Universal Resolver (Bug #4).`,
      501: `HTTP 501 — "did:${method}" method driver NOT registered in DIF Universal Resolver (Bug #4). HTTP 501 means the resolver exists but has no driver for this method.`,
    };

    return {
      did, method, resolved: false, httpStatus, didDocument: null, resolverUrl,
      resolverEvidence: { timestamp, evidenceHash, rawResponse: rawBody,
        note: noteMap[httpStatus] || `HTTP ${httpStatus} — Unexpected response from Universal Resolver.` },
      cached: false,
    };
  }

  /** @private */
  _buildErrorResult(did, code, reason) {
    return {
      did, method: null, resolved: false, httpStatus: null, didDocument: null, resolverUrl: null,
      resolverEvidence: { error: { code, reason }, timestamp: new Date().toISOString() },
      cached: false,
    };
  }
}

export const didResolverService = new DIDResolverService();
