import { randomUUID } from 'node:crypto';
import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const REPORTS_DIR = join(process.cwd(), 'reports');

/**
 * Report Generator Service
 *
 * Generates structured JSON compliance audit reports with strict decision policy:
 *
 * DECISION POLICY (fail-safe):
 * ┌────────────────────────────────────────────┬───────────────┐
 * │ Condition                                  │ Max Decision  │
 * ├────────────────────────────────────────────┼───────────────┤
 * │ Address sanctioned (OFAC)                  │ REJECT        │
 * │ DID format invalid                         │ REJECT        │
 * │ Trust manifest not verified                │ REVIEW        │
 * │ DID not resolved by Universal Resolver     │ REVIEW        │
 * │ Sanctions oracle inconclusive              │ REVIEW        │
 * │ Any RPC disconnected                       │ REVIEW        │
 * │ All checks valid + riskScore < 30          │ APPROVE       │
 * └────────────────────────────────────────────┴───────────────┘
 *
 * The rule is: inconclusive data NEVER produces automatic APPROVE.
 *
 * Note on auditSignature: The SHA-256 hash provides content integrity
 * (tamper detection), NOT a cryptographic signature with a private key.
 * It should be documented as "integrity hash", not "digital signature".
 */
export class ReportGeneratorService {
  constructor() {
    this._ensureReportsDir();
  }

  /**
   * Generates and persists a compliance report.
   *
   * @param {object} params
   * @param {string}   params.agentDid
   * @param {object}   params.didResolution - from DIDResolverService
   * @param {object[]} params.chainAudits   - from ComplianceService.runMultiChainAudit()
   * @param {object}   params.requestData
   * @param {boolean}  params.trustVerified - was the T3N trust manifest successfully fetched?
   * @returns {object} Complete report object
   */
  generate({ agentDid, didResolution, chainAudits, requestData, trustVerified = false }) {
    const reportId = `RPT-${randomUUID().split('-')[0].toUpperCase()}`;
    const generatedAt = new Date().toISOString();

    // Aggregate risk indicators across all chains
    const totalTxCount = chainAudits.reduce((s, a) => s + (a.liveOnChainData?.txCountOnChain || 0), 0);
    const hasAnyBalance = chainAudits.some(a => parseFloat(a.liveOnChainData?.realBalanceEth || '0') > 0);
    const allRpcsConnected = chainAudits.every(a => a.liveOnChainData?.rpcConnected === true);
    const anySanctioned = chainAudits.some(a => a.complianceChecks?.sanctionsPassed === false && a.complianceChecks?.sanctionsSource !== 'FORMAT_CHECK');
    const sanctionsInconclusive = chainAudits.some(a => a.complianceChecks?.sanctionsPassed === null);

    const riskScore = this._calculateRiskScore({
      didResolution, totalTxCount, hasAnyBalance, allRpcsConnected, trustVerified,
    });

    const complianceDecision = this._makeDecision({
      riskScore, didResolution, trustVerified, allRpcsConnected,
      anySanctioned, sanctionsInconclusive,
    });

    const report = {
      reportId,
      schemaVersion: '1.2.0',
      generatedAt,
      agentDid,
      agentName: config.agent.name,
      trustVerified,
      request: {
        subjectDid: requestData.userDid,
        targetWalletAddress: requestData.targetWalletAddress,
        requestedChains: chainAudits.map(a => a.chain),
      },
      subject: {
        did: didResolution.did,
        method: didResolution.method,
        formatValid: didResolution.method !== null,
        resolved: didResolution.resolved,
        httpStatus: didResolution.httpStatus,
        didDocument: didResolution.didDocument,
        resolverEvidence: didResolution.resolverEvidence,
      },
      auditTrail: chainAudits.map(audit => ({
        chain: audit.chain,
        rpcUrl: audit.rpcUrl || null,
        auditTimestamp: audit.timestamp,
        blockNumber: audit.liveOnChainData?.blockNumber || null,
        balanceEth: audit.liveOnChainData?.realBalanceEth || '0 ETH',
        txCount: audit.liveOnChainData?.txCountOnChain || 0,
        rpcConnected: audit.liveOnChainData?.rpcConnected || false,
        hasActivity: audit.liveOnChainData?.hasActivity || false,
        complianceChecks: audit.complianceChecks || {},
      })),
      complianceDecision,
      riskScore,
      decisionReasons: this._buildDecisionReasons({
        trustVerified, didResolution, allRpcsConnected,
        anySanctioned, sanctionsInconclusive, riskScore,
      }),
      summary: this._buildSummary({ complianceDecision, riskScore, didResolution, totalTxCount, chainAudits, trustVerified }),
    };

    // Integrity hash (SHA-256 of report body — tamper detection, NOT a digital signature)
    const bodyForHash = JSON.stringify({
      reportId, agentDid, trustVerified,
      subject: report.subject, auditTrail: report.auditTrail,
    });
    report.integrityHash = 'sha256:' + createHash('sha256').update(bodyForHash).digest('hex');

    // Persist to disk
    const fileName = `audit-${reportId}-${Date.now()}.json`;
    const filePath = join(REPORTS_DIR, fileName);
    // Set this before serialization so the persisted report is self-locating.
    // It is intentionally excluded from the integrity hash because the path is
    // an output location, not compliance evidence.
    report.reportFile = filePath;

    try {
      writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
      console.log(`\n📁 [Report Generator] Report saved: ${filePath}`);
    } catch (err) {
      console.warn(`⚠️ [Report Generator] Could not persist report: ${err.message}`);
      report.reportFile = null;
    }

    return report;
  }

  /**
   * Strict decision policy. Inconclusive data NEVER produces APPROVE.
   * @private
   */
  _makeDecision({ riskScore, didResolution, trustVerified, allRpcsConnected, anySanctioned, sanctionsInconclusive }) {
    // Hard REJECT — cannot be overridden
    if (anySanctioned) return 'REJECT';
    if (!didResolution.method) return 'REJECT'; // DID format invalid

    // Conditions that cap decision at REVIEW — audit incomplete or trust not established
    if (!trustVerified) return 'REVIEW';           // T3N trust manifest not verified (Bug #2)
    if (!didResolution.resolved) return 'REVIEW';  // DID not resolvable — identity unconfirmed
    if (sanctionsInconclusive) return 'REVIEW';    // Sanctions oracle unavailable
    if (!allRpcsConnected) return 'REVIEW';        // Incomplete on-chain data

    // All trust checks passed — apply risk-based decision
    if (riskScore >= 70) return 'REJECT';
    if (riskScore >= 30) return 'REVIEW';
    return 'APPROVE';
  }

  /**
   * Human-readable explanation of why this decision was made.
   * @private
   */
  _buildDecisionReasons({ trustVerified, didResolution, allRpcsConnected, anySanctioned, sanctionsInconclusive, riskScore }) {
    const reasons = [];
    if (anySanctioned) reasons.push('REJECT: Address found in OFAC sanctions list.');
    if (!didResolution.method) reasons.push('REJECT: DID format invalid.');
    if (!trustVerified) reasons.push('REVIEW: T3N trust manifest not verified (fetchTrustedManifest failed — Bug #2).');
    if (!didResolution.resolved) reasons.push(`REVIEW: DID not resolved by Universal Resolver (HTTP ${didResolution.httpStatus} — Bug #4).`);
    if (sanctionsInconclusive) reasons.push('REVIEW: Sanctions oracle inconclusive — fail-safe applied.');
    if (!allRpcsConnected) reasons.push('REVIEW: One or more RPC connections failed.');
    if (reasons.length === 0) reasons.push(`APPROVE: All trust and compliance checks passed (riskScore: ${riskScore}).`);
    return reasons;
  }

  /** @private */
  _calculateRiskScore({ didResolution, totalTxCount, hasAnyBalance, allRpcsConnected, trustVerified }) {
    let score = 0;
    if (!trustVerified) score += 30;
    if (!didResolution.resolved) score += 20;
    if (totalTxCount === 0) score += 20;
    if (!hasAnyBalance) score += 10;
    if (!allRpcsConnected) score += 20;
    return Math.min(score, 100);
  }

  /** @private */
  _buildSummary({ complianceDecision, riskScore, didResolution, totalTxCount, chainAudits, trustVerified }) {
    return {
      decision: complianceDecision,
      riskScore,
      trustVerified,
      didResolutionStatus: didResolution.resolved ? 'RESOLVED' : `UNRESOLVABLE (HTTP ${didResolution.httpStatus || 'N/A'})`,
      chainsAudited: chainAudits.map(a => a.chain).join(', '),
      totalTxCountAcrossChains: totalTxCount,
    };
  }

  /** @private */
  _ensureReportsDir() {
    try {
      if (!existsSync(REPORTS_DIR)) mkdirSync(REPORTS_DIR, { recursive: true });
    } catch (err) {
      console.warn(`⚠️ [Report Generator] Could not create reports dir: ${err.message}`);
    }
  }
}

export const reportGeneratorService = new ReportGeneratorService();
