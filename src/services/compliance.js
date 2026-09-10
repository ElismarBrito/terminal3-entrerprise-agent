import { randomUUID } from 'node:crypto';
import { ethers } from 'ethers';
import { config } from '../config.js';
import { didResolverService } from './did-resolver.js';
import { sanctionsService } from './sanctions.js';

export class ComplianceService {
  constructor() {
    this.auditLogs = [];
  }

  async verifyDidSubject(didString) {
    console.log(`   🔬 [DID Verify] Step 1/2: Format validation (strict schema)...`);
    const formatCheck = didResolverService.validateFormat(didString);

    if (!formatCheck.valid) {
      return {
        valid: false, did: didString, reason: formatCheck.reason,
        formatValid: false, resolved: false, didDocument: null,
        resolverEvidence: null, verifiedAt: new Date().toISOString(),
        status: 'REJECTED_INVALID_FORMAT',
      };
    }

    console.log(`   🌐 [DID Verify] Step 2/2: Network resolution via Universal Resolver...`);
    const resolution = await didResolverService.resolve(didString);

    return {
      valid: formatCheck.valid, did: didString, method: formatCheck.method,
      t3nParsed: formatCheck.t3nParsed || null, formatValid: true,
      resolved: resolution.resolved, httpStatus: resolution.httpStatus,
      didDocument: resolution.didDocument, resolverEvidence: resolution.resolverEvidence,
      subjectAddress: formatCheck.t3nParsed?.address || null,
      verifiedAt: new Date().toISOString(),
      status: resolution.resolved ? 'FULLY_RESOLVED' : 'FORMAT_VALID_UNRESOLVABLE',
    };
  }

  async runOnChainAudit(targetWalletAddress, chainKey = 'sepolia') {
    const timestamp = new Date().toISOString();
    const rpcUrl = config.agent.supportedChains[chainKey] || config.agent.supportedChains.sepolia;

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

    console.log(`   🛡️  [Sanctions] Querying Chainalysis OFAC Oracle for ${targetWalletAddress}...`);
    const sanctionsResult = await sanctionsService.checkSanctions(targetWalletAddress);
    const kycResult = sanctionsService.deriveKycTier(txCount);

    const isPositiveBalance = parseFloat(balanceEther) > 0;

    const auditRecord = {
      // crypto.randomUUID() for cryptographically random, collision-free IDs
      auditId: `AUDIT-${randomUUID().split('-')[0].toUpperCase()}`,
      walletAddress: targetWalletAddress,
      chain: chainKey,
      rpcUrl,
      timestamp,
      liveOnChainData: {
        rpcConnected, blockNumber,
        realBalanceEth: balanceEther + ' ETH',
        txCountOnChain: txCount,
        hasActivity: txCount > 0 || isPositiveBalance,
      },
      complianceChecks: {
        sanctionsPassed: sanctionsResult.sanctionsPassed,
        sanctionsSource: sanctionsResult.source,
        sanctionsOracleQueried: sanctionsResult.oracleQueried,
        sanctionsNote: sanctionsResult.note,
        kycLevel: kycResult.kycLevel,
        kycBasis: kycResult.kycBasis,
        riskScore: this._computeChainRiskScore({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }),
      },
      recommendation: this._makeChainRecommendation({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }),
    };

    this.auditLogs.push(auditRecord);
    return auditRecord;
  }

  async runMultiChainAudit(targetWalletAddress, chains = ['sepolia']) {
    console.log(`   🔗 [Multi-Chain Audit] ${chains.length} chain(s): ${chains.join(', ')}`);
    const results = await Promise.allSettled(
      chains.map(chain => this.runOnChainAudit(targetWalletAddress, chain))
    );
    return results.map((result, idx) => {
      if (result.status === 'fulfilled') return result.value;
      return {
        auditId: `AUDIT-FAIL-${randomUUID().split('-')[0].toUpperCase()}`,
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

  _computeChainRiskScore({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }) {
    if (sanctionsResult.isSanctioned === true) return 100;
    if (sanctionsResult.sanctionsPassed === null) return 85;
    if (!rpcConnected) return 75;
    if (txCount === 0 && !isPositiveBalance) return 50;
    if (isPositiveBalance && txCount > 10) return 10;
    if (isPositiveBalance || txCount > 0) return 25;
    return 40;
  }

  _makeChainRecommendation({ isPositiveBalance, txCount, rpcConnected, sanctionsResult }) {
    if (sanctionsResult.isSanctioned === true) return 'REJECT_OFAC_SANCTIONS';
    if (sanctionsResult.sanctionsPassed === null) return 'AUDIT_INCONCLUSIVE_SANCTIONS_UNAVAILABLE';
    if (!rpcConnected) return 'AUDIT_INCONCLUSIVE_RPC_UNAVAILABLE';
    if (isPositiveBalance || txCount > 0) return 'APPROVE_TRANSACTION';
    return 'REQUIRE_ADDITIONAL_VERIFICATION';
  }
}

export const complianceService = new ComplianceService();
