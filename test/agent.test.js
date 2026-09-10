import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { T3EnterpriseAgent } from '../src/agent.js';
import { complianceService } from '../src/services/compliance.js';
import { didResolverService } from '../src/services/did-resolver.js';
import { reportGeneratorService } from '../src/services/report-generator.js';

// ─── Test 1: Agent Initialization & ADK Handshake ────────────────────────────
test('T3EnterpriseAgent: Initialization & ADK Handshake', async () => {
  const agent = new T3EnterpriseAgent();
  assert.equal(agent.isInitialized, false, 'Agent should not be initialized before initialize()');

  await agent.initialize();

  assert.equal(agent.isInitialized, true, 'Agent should be initialized after initialize()');
  assert.ok(agent.tenantDid.startsWith('did:t3n:'), `tenantDid must start with "did:t3n:", got: ${agent.tenantDid}`);
  assert.equal(typeof agent.adkConnected, 'boolean', 'adkConnected must be a boolean');
});

// ─── Test 2: DID Format Validation ───────────────────────────────────────────
test('DIDResolverService: Format Validation (valid and invalid)', () => {
  const cases = [
    { did: 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC', expectValid: true },
    { did: 'did:web:example.com', expectValid: true },
    { did: 'did:key:z6MkHaXgBZDvotDkL5257faiztiGiC2QtKLGpbnnEGta2doK', expectValid: true },
    { did: 'invalid:scheme:123', expectValid: false },
    { did: 'did:', expectValid: false },
    { did: '', expectValid: false },
    { did: null, expectValid: false },
  ];

  for (const { did, expectValid } of cases) {
    const result = didResolverService.validateFormat(did);
    assert.equal(result.valid, expectValid, `DID "${did}" expected valid=${expectValid}, got ${result.valid}. Reason: ${result.reason}`);
  }
});

// ─── Test 3: DID Resolution via Universal Resolver (Real HTTP Call) ──────────
test('DIDResolverService: Real HTTP Resolution via Universal Resolver', async () => {
  // did:t3n is the method we are testing — it may or may not be registered
  const t3nDid = 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const resolution = await didResolverService.resolve(t3nDid);

  assert.equal(resolution.did, t3nDid, 'Resolution result must echo back the input DID');
  assert.ok(resolution.resolverUrl.includes('uniresolver.io'), 'Resolver URL must reference the Universal Resolver');
  assert.equal(typeof resolution.resolved, 'boolean', 'resolved must be a boolean');
  assert.ok(resolution.resolverEvidence, 'Resolution must include evidence object');
  assert.ok(resolution.resolverEvidence.timestamp, 'Evidence must include a timestamp');
  assert.ok(resolution.resolverEvidence.evidenceHash, 'Evidence must include an integrity hash');

  // We expect HTTP 404 or 501 for did:t3n (not registered in Universal Resolver)
  // HTTP 501 = "Not Implemented" (method driver not installed) — more precise than 404
  // This is documented as Bug #4 — we assert this behavior as evidence
  if (resolution.httpStatus !== null) {
    console.log(`   ℹ️  HTTP Status from Universal Resolver for did:t3n: ${resolution.httpStatus} (Bug #4 evidence)`);
    assert.ok([200, 400, 404, 501, 500, null].includes(resolution.httpStatus),
      `Unexpected HTTP status: ${resolution.httpStatus}`);
  } else {
    // Network error or timeout — still valid test, just inconclusive
    console.log(`   ℹ️  Universal Resolver unreachable (network/timeout) — see resolverEvidence.error`);
  }
});

// ─── Test 4: Compliance DID Verify with Resolver Integration ─────────────────
test('ComplianceService: verifyDidSubject with real resolver integration', async () => {
  const validDid = 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const invalidDid = 'not-a-valid-did';

  const validResult = await complianceService.verifyDidSubject(validDid);
  assert.equal(validResult.valid, true, 'A correctly formatted did:t3n should be valid');
  assert.equal(validResult.formatValid, true, 'Format must be valid');
  assert.ok(validResult.resolverEvidence, 'Must include resolver evidence from real HTTP call');
  assert.ok(['FULLY_RESOLVED', 'FORMAT_VALID_UNRESOLVABLE'].includes(validResult.status),
    `Unexpected status: ${validResult.status}`);

  const invalidResult = await complianceService.verifyDidSubject(invalidDid);
  assert.equal(invalidResult.valid, false, 'An invalid DID string must return valid=false');
  assert.equal(invalidResult.formatValid, false);
});

// ─── Test 5: Single-Chain On-Chain Audit (Sepolia) ───────────────────────────
test('ComplianceService: Single-Chain Live On-Chain Audit (Sepolia)', async () => {
  const sampleWallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const auditRecord = await complianceService.runOnChainAudit(sampleWallet, 'sepolia');

  assert.ok(auditRecord.auditId.startsWith('AUDIT-'), 'auditId must start with "AUDIT-"');
  assert.equal(auditRecord.walletAddress, sampleWallet);
  assert.equal(auditRecord.chain, 'sepolia');
  assert.ok(auditRecord.rpcUrl.includes('publicnode.com'), 'Must use configured RPC URL');
  assert.ok(auditRecord.liveOnChainData.realBalanceEth.includes('ETH'), 'Balance must include "ETH" unit');
  assert.equal(typeof auditRecord.liveOnChainData.txCountOnChain, 'number');
  // blockNumber is fetched live — may be null if RPC fails, but should be a number when connected
  if (auditRecord.liveOnChainData.rpcConnected) {
    assert.equal(typeof auditRecord.liveOnChainData.blockNumber, 'number', 'blockNumber must be a number when RPC is connected');
    assert.ok(auditRecord.liveOnChainData.blockNumber > 0, 'blockNumber must be positive');
  }
});

// ─── Test 6: Multi-Chain Audit ───────────────────────────────────────────────
test('ComplianceService: Multi-Chain Audit returns results for each chain', async () => {
  const sampleWallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const chains = ['sepolia', 'base'];
  const results = await complianceService.runMultiChainAudit(sampleWallet, chains);

  assert.equal(results.length, chains.length, 'Must return one audit record per chain');

  for (const [i, result] of results.entries()) {
    const expectedChain = chains[i];
    assert.equal(result.chain, expectedChain, `Result[${i}] must be for chain "${expectedChain}"`);
    assert.ok(result.walletAddress === sampleWallet || result.error, 'Must include wallet or error');
    assert.ok(result.liveOnChainData, 'Must include liveOnChainData');
  }
});

// ─── Test 7: Report Generator produces valid structured JSON ──────────────────
test('ReportGeneratorService: Generates valid structured JSON report with signature', async () => {
  const mockDidResolution = {
    did: 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    method: 't3n',
    resolved: false,
    httpStatus: 404,
    didDocument: null,
    resolverEvidence: {
      timestamp: new Date().toISOString(),
      evidenceHash: 'abc123',
      note: 'HTTP 404 — did:t3n not registered in Universal Resolver (Bug #4)',
    },
  };

  const mockChainAudits = [{
    auditId: 'AUDIT-TEST',
    walletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346',
    chain: 'sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    timestamp: new Date().toISOString(),
    liveOnChainData: {
      rpcConnected: true,
      blockNumber: 7654321,
      realBalanceEth: '0.5 ETH',
      txCountOnChain: 42,
      hasActivity: true,
    },
    complianceChecks: { kycLevel: 'TIER_3_ENTERPRISE', riskScore: 10 },
    recommendation: 'APPROVE_TRANSACTION',
  }];

  const report = reportGeneratorService.generate({
    agentDid: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    didResolution: mockDidResolution,
    chainAudits: mockChainAudits,
    requestData: { userDid: mockDidResolution.did, targetWalletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346', chains: ['sepolia'] },
  });

  // Schema validation
  assert.ok(report.reportId.startsWith('RPT-'), 'reportId must start with "RPT-"');
  assert.equal(report.schemaVersion, '1.0.0');
  assert.ok(report.generatedAt, 'generatedAt must be present');
  assert.ok(report.auditSignature.startsWith('sha256:'), 'auditSignature must be sha256 hash');
  assert.ok(['APPROVE', 'REVIEW', 'REJECT'].includes(report.complianceDecision), `Invalid decision: ${report.complianceDecision}`);
  assert.equal(typeof report.riskScore, 'number', 'riskScore must be a number');
  assert.ok(report.riskScore >= 0 && report.riskScore <= 100, 'riskScore must be 0-100');
  assert.ok(Array.isArray(report.auditTrail), 'auditTrail must be an array');
  assert.equal(report.auditTrail.length, 1);
  assert.ok(report.subject.resolverEvidence, 'subject must include resolverEvidence');

  // Verify file was saved to disk
  if (report.reportFile) {
    assert.ok(existsSync(report.reportFile), `Report file must exist at: ${report.reportFile}`);
  }

  // Verify reports directory exists
  const reportsDir = join(process.cwd(), 'reports');
  assert.ok(existsSync(reportsDir), 'reports/ directory must exist');

  const reportFiles = readdirSync(reportsDir).filter(f => f.endsWith('.json'));
  assert.ok(reportFiles.length > 0, 'At least one report JSON must exist in reports/');
});
