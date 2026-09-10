import { ethers } from 'ethers';
import { config } from '../config.js';
import { didResolverService } from './did-resolver.js';
import { sanctionsService } from './sanctions.js';

/**
 * Compliance Service
 *
 * Orchestrates:
 *  1. DID verification — strict schema (did:t3n) + real HTTP resolution
 *  2. Sanctions check — real Chainalysis OFAC Oracle (on-chain, no API key)
 *  3. On-chain RPC audit — balance, txCount, blockNumber via ethers.js
 *  4. KYC tier derivation — based on real txCount, not hardcoded
 */
export class ComplianceService {
  constructor() {
    this.auditLogs = [];
  }

  /**
   * Verifies a DID subject with two layers:
   *  - Strict format validation (did:t3n schema or W3C for other methods)
   *  - Real HTTP resolution attempt via DIF Universal Resolver
   *
   * @param {string} didString
   * @returns {Promise<DIDVerificationResult>}
   */
  async verifyDidSubject(didString) {
    console.log(`   🔬 [DID Verify] Step 1/2: Format validation (strict schema)...`);
    const formatCheck = didResolverService.validateFormat(didString);

    if (!formatCheck.valid) {
      return {
        valid: false,
        did: didString,
        reason: formatCheck.reason,
        formatValid: false,
        resolved: false,
        didDocument: null,
        resolverEvidence: null,
        verifiedAt: new Date().toISOString(),
        status: 'REJECTED_INVALID_FORMAT',
      };
    }

    console.log(`   🌐 [DID Verify] Step 2/2: Network resolution via Universal Resolver...`);
    const resolution = await didResolverService.resolve(didString);

    // For did:t3n: since HTTP 501 means the method is not registered in DIF,
    // the DID cannot be independently verified by third parties.
    // We mark it as FORMAT_VALID_UNRESOLVABLE and raise risk score accordingly.
    // It is NOT marked as invalid — the format is correct, but resolution failed.
    return {
      valid: formatCheck.valid,
      did: didString,
      method: formatCheck.method,
      t3nParsed: formatCheck.t3nParsed || null,
      formatValid: true,
      resolved: resolution.resolved,
      httpStatus: resolution.httpStatus,
      didDocument: resolution.didDocument,
      resolverEvidence: resolution.resolverEvidence,
      subjectAddress: formatCheck.t3nParsed?.address || null,
      verifiedAt: new Date().toISOString(),
      status: resolution.resolved ? 'FULLY_RESOLVED' : 'FORMAT_VALID_UNRESOLVABLE',
    };
  }

  /**
   * Full on-chain audit: balance, txCount, blockNumber + sanctions check + KYC tier.
   *
   * @param {string} targetWalletAddress
   * @param {string} chainKey
   * @returns {Promise<AuditRecord>}
   */
  async runOnChainAudit(targetWalletAddress, chainKey = 'sepolia') {
    const timestamp = new Date().toISOString();
    const rpcUrl = config.agent.supportedChains[chainKey] || config.agent.supportedChains.sepolia;

    // ── RPC Data ─────────────────────────────────────────────────────────────
    let balanceEther = '0.00';
    let txCount = 0;
    let blockNumber = null;
    let rpcConnected = false;

    try {
      const provider = new ethers.JsonRpcProvider(rpcUrl);
      const [balanceWei, txCountResult, currentBlock] = await Promise.all([
        provider.getBalance(targetWalletAddress),
        provider.getTransactionCount(targetWalletAddress),
        provider.getBlockNumber(),
      ]);

      balanceEther = ethers.formatEther(balanceWei);
      txCount = txCountResult;
      blockNumber = currentBlock;
      rpcConnected = true;

    } catch (e) {
      console.warn(`⚠️ [RPC Audit] ${chainKey}/${targetWalletAddress}: ${e.message}`);
    }

    // ── Sanctions Check (Real Chainalysis OFAC Oracle) ────────────────────────
    console.log(`   🛡️  [Sanctions] Querying Chainalysis OFAC Oracle for ${targetWalletAddress}...`);
    const sanctionsResult = await sanctionsService.checkSanctions(targetWalletAddress);

    // ── KYC Tier (derived from real txCount, not hardcoded) ──────────────────
    const kycResult = sanctionsService.deriveKycTier(txCount);

    const isPositiveBalance = parseFloat(balanceEther) > 0;

    const auditRecord = {
      auditId: 'AUDIT-' + Math.random().toString(36).substring(2, 9).toUpperCase(),
      walletAddress: targetWalletAddress,
      chain: chainKey,
      rpcUrl,
      timestamp,
      liveOnChainData: {
        rpcConnected,
        blockNumber,
        realBalanceEth: balanceEther + ' ETH',
        txCountOnChain: txCount,
        hasActivity: txCount > 0 || isPositiveBalance,
      },
      complianceChecks: {
        // Real sanctions data from Chainalysis OFAC Oracle
        sanctionsPassed: sanctionsResult.sanctionsPassed,
        sanctionsSource: sanctionsResult.source,
        sanctionsOracleQueried: sanctionsResult.oracleQueried,
        sanctionsNote: sanctionsResult.note,
        // KYC tier derived from real on-chain txCount
        kycLevel: kycResult.kycLevel,
        kycBasis: kycResult.kycBasis,
        riskScore: this._computeChainRiskScore({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }),
      },
      recommendation: this._makeChainRecommendation({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }),
    };

    this.auditLogs.push(auditRecord);
    return auditRecord;
  }

  /**
   * Concurrent multi-chain audit.
   *
   * @param {string} targetWalletAddress
   * @param {string[]} chains
   * @returns {Promise<AuditRecord[]>}
   */
  async runMultiChainAudit(targetWalletAddress, chains = ['sepolia']) {
    console.log(`   🔗 [Multi-Chain Audit] ${chains.length} chain(s): ${chains.join(', ')}`);
    const results = await Promise.allSettled(
      chains.map(chain => this.runOnChainAudit(targetWalletAddress, chain))
    );

    return results.map((result, idx) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        auditId: 'AUDIT-FAIL-' + chains[idx].toUpperCase(),
        walletAddress: targetWalletAddress,
        chain: chains[idx],
        timestamp: new Date().toISOString(),
        error: result.reason?.message || 'Unknown error',
        liveOnChainData: { rpcConnected: false, blockNumber: null, realBalanceEth: '0 ETH', txCountOnChain: 0, hasActivity: false },
        complianceChecks: { sanctionsPassed: null, kycLevel: 'UNVERIFIED', riskScore: 100 },
        recommendation: 'AUDIT_FAILED',
      };
    });
  }

  /** @private */
  _computeChainRiskScore({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }) {
    // Fail-safe: sanctioned = maximum risk
    if (sanctionsResult.isSanctioned === true) return 100;
    // Inconclusive sanctions = high risk (fail-safe)
    if (sanctionsResult.sanctionsPassed === null) return 85;
    if (!rpcConnected) return 75;
    if (txCount === 0 && !isPositiveBalance) return 50;
    if (isPositiveBalance && txCount > 10) return 10;
    if (isPositiveBalance || txCount > 0) return 25;
    return 40;
  }

  /** @private */
  _makeChainRecommendation({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }) {
    if (sanctionsResult.isSanctioned === true) return 'REJECT_OFAC_SANCTIONS';
    if (sanctionsResult.sanctionsPassed === null) return 'AUDIT_INCONCLUSIVE_SANCTIONS_UNAVAILABLE';
    if (!rpcConnected) return 'AUDIT_INCONCLUSIVE_RPC_UNAVAILABLE';
    if (isPositiveBalance || txCount > 0) return 'APPROVE_TRANSACTION';
    return 'REQUIRE_ADDITIONAL_VERIFICATION';
  }
}

export const complianceService = new ComplianceService();
