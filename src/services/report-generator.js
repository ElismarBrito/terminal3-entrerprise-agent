import { createHash } from 'crypto';
import { mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config } from '../config.js';

const REPORTS_DIR = join(process.cwd(), 'reports');

/**
 * Report Generator Service
 *
 * Generates structured, audit-trail JSON reports from enterprise compliance
 * audit results. Each report is persisted to disk under the `reports/`
 * directory with a unique ID and a SHA-256 integrity signature.
 *
 * Report Schema:
 * {
 *   reportId, generatedAt, schemaVersion, agentDid,
 *   subject: { did, formatValid, resolved, didDocument, resolverEvidence },
 *   auditTrail: [{ chain, rpcUrl, blockNumber, balanceEth, txCount, ... }],
 *   complianceDecision: "APPROVE | REVIEW | REJECT",
 *   riskScore, summary, auditSignature
 * }
 */
export class ReportGeneratorService {
  constructor() {
    this._ensureReportsDir();
  }

  /**
   * Generates and persists a structured compliance audit report.
   *
   * @param {object} params
   * @param {string} params.agentDid - The DID of the agent issuing the report
   * @param {object} params.didResolution - Result from DIDResolverService.resolve()
   * @param {object[]} params.chainAudits - Array of on-chain audit records
   * @param {object} params.requestData - Original request payload
   * @returns {object} The complete report object, including file path
   */
  generate({ agentDid, didResolution, chainAudits, requestData }) {
    const reportId = 'RPT-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const generatedAt = new Date().toISOString();

    // Aggregate risk across all chains
    const totalTxCount = chainAudits.reduce((sum, a) => sum + (a.liveOnChainData?.txCountOnChain || 0), 0);
    const hasAnyBalance = chainAudits.some(a => parseFloat(a.liveOnChainData?.realBalanceEth || '0') > 0);
    const allRpcsConnected = chainAudits.every(a => a.liveOnChainData?.rpcConnected);

    const riskScore = this._calculateRiskScore({ didResolution, totalTxCount, hasAnyBalance, allRpcsConnected });
    const complianceDecision = this._makeDecision(riskScore, didResolution);

    const report = {
      reportId,
      schemaVersion: '1.0.0',
      generatedAt,
      agentDid,
      agentName: config.agent.name,
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
      summary: this._buildSummary({ complianceDecision, riskScore, didResolution, totalTxCount, chainAudits }),
    };

    // Add integrity signature (SHA-256 of report body)
    const bodyForSigning = JSON.stringify({ reportId, agentDid, subject: report.subject, auditTrail: report.auditTrail });
    report.auditSignature = 'sha256:' + createHash('sha256').update(bodyForSigning).digest('hex');

    // Persist report to disk
    const fileName = `audit-${reportId}-${Date.now()}.json`;
    const filePath = join(REPORTS_DIR, fileName);

    try {
      writeFileSync(filePath, JSON.stringify(report, null, 2), 'utf-8');
      report.reportFile = filePath;
      console.log(`\n📁 [Report Generator] Structured report saved: ${filePath}`);
    } catch (err) {
      console.warn(`⚠️ [Report Generator] Could not persist report to disk: ${err.message}`);
      report.reportFile = null;
    }

    return report;
  }

  /**
   * Calculates a composite risk score from 0 (safe) to 100 (high risk).
   * @private
   */
  _calculateRiskScore({ didResolution, totalTxCount, hasAnyBalance, allRpcsConnected }) {
    let score = 0;

    // DID resolution failure adds risk
    if (!didResolution.resolved) score += 20;
    if (didResolution.httpStatus === 404) score += 10; // Method not registered — expected for did:t3n

    // No on-chain activity adds risk
    if (totalTxCount === 0) score += 25;
    if (!hasAnyBalance) score += 15;

    // RPC connectivity issues add risk
    if (!allRpcsConnected) score += 20;

    return Math.min(score, 100);
  }

  /**
   * @private
   */
  _makeDecision(riskScore, didResolution) {
    // Format must be valid at minimum
    if (didResolution.method === null) return 'REJECT';
    if (riskScore >= 70) return 'REJECT';
    if (riskScore >= 30) return 'REVIEW';
    return 'APPROVE';
  }

  /**
   * @private
   */
  _buildSummary({ complianceDecision, riskScore, didResolution, totalTxCount, chainAudits }) {
    const chains = chainAudits.map(a => a.chain).join(', ');
    return {
      decision: complianceDecision,
      riskScore,
      didResolutionStatus: didResolution.resolved ? 'RESOLVED' : `UNRESOLVABLE (HTTP ${didResolution.httpStatus || 'N/A'})`,
      chainsAudited: chains,
      totalTxCountAcrossChains: totalTxCount,
      notes: didResolution.resolverEvidence?.note || null,
    };
  }

  /**
   * @private
   */
  _ensureReportsDir() {
    try {
      if (!existsSync(REPORTS_DIR)) {
        mkdirSync(REPORTS_DIR, { recursive: true });
      }
    } catch (err) {
      console.warn(`⚠️ [Report Generator] Could not create reports directory: ${err.message}`);
    }
  }
}

export const reportGeneratorService = new ReportGeneratorService();
