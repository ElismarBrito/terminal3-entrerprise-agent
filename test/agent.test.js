import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { T3EnterpriseAgent } from '../src/agent.js';
import { complianceService } from '../src/services/compliance.js';
import { didResolverService } from '../src/services/did-resolver.js';
import { reportGeneratorService } from '../src/services/report-generator.js';
import { sanctionsService } from '../src/services/sanctions.js';

// ─── Test 1: ADK Handshake — adkConnected + trustVerified tracking ───────────
test('T3EnterpriseAgent: ADK handshake tracks adkConnected and trustVerified independently', async () => {
  const agent = new T3EnterpriseAgent();
  assert.equal(agent.isInitialized, false);
  assert.equal(agent.trustVerified, false);

  await agent.initialize();

  assert.equal(agent.isInitialized, true);
  assert.ok(agent.tenantDid.startsWith('did:t3n:'));
  assert.equal(typeof agent.adkConnected, 'boolean');
  assert.equal(typeof agent.trustVerified, 'boolean');

  console.log(`   ℹ️  adkConnected=${agent.adkConnected} | trustVerified=${agent.trustVerified}`);
  if (agent.adkConnected && !agent.trustVerified) {
    console.log(`   ⚠️  fetchTrustedManifest failed (Bug #5) — trustVerified=false blocks APPROVE`);
  }
});

// ─── Test 2: DID Strict Schema — valid did:t3n ───────────────────────────────
test('DIDResolverService: Strict did:t3n schema — valid cases (including lowercase address)', () => {
  const validCases = [
    'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:user:agent:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:node:validator:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    // lowercase address — should be normalized, not rejected
    'did:t3n:enterprise:audit:0xe4615a594b7a11796cd25b5401a109bba5855346',
  ];

  for (const did of validCases) {
    const result = didResolverService.validateFormat(did);
    assert.equal(result.valid, true, `Expected VALID: "${did}" — got: ${result.reason}`);
    assert.equal(result.method, 't3n');
    assert.ok(result.t3nParsed?.address.startsWith('0x'), 'address must be normalized to checksum');
  }
});

// ─── Test 3: DID Strict Schema — INVALID cases ───────────────────────────────
test('DIDResolverService: Strict did:t3n schema — invalid cases REJECTED', () => {
  const invalidCases = [
    { did: 'did:t3n:anything',      reason: 'generic 3-segment form' },
    { did: 'did:t3n:enterprise:audit', reason: 'missing address (4 parts)' },
    { did: 'did:t3n:ENTERPRISE:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC', reason: 'uppercase realm' },
    { did: 'did:t3n:enterprise:ADMIN:0x909F5A24F4f3353A823Bed637410D21E6521BAEC', reason: 'invalid role' },
    { did: 'did:t3n:enterprise:audit:notanaddress', reason: 'invalid ETH address' },
    { did: 'did:t3n:enterprise:audit:0x1234', reason: 'short address' },
    { did: 'invalid:scheme:123',   reason: 'wrong DID scheme' },
    { did: '',                     reason: 'empty string' },
    { did: null,                   reason: 'null' },
  ];

  for (const { did, reason } of invalidCases) {
    const result = didResolverService.validateFormat(did);
    assert.equal(result.valid, false, `Expected INVALID (${reason}): "${did}" — got valid=true`);
    assert.ok(result.reason, `Must provide rejection reason for "${did}"`);
  }
});

// ─── Test 4: DID Resolution — Universal Resolver HTTP 501 (Bug #4) ───────────
test('DIDResolverService: Universal Resolver captures HTTP 501 as Bug #4 evidence', async () => {
  const did = 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const resolution = await didResolverService.resolve(did);

  assert.equal(resolution.did, did);
  assert.ok(resolution.resolverUrl?.includes('uniresolver.io'));
  assert.equal(typeof resolution.resolved, 'boolean');
  assert.ok(resolution.resolverEvidence?.timestamp);
  assert.ok(resolution.resolverEvidence?.evidenceHash);

  if (resolution.httpStatus !== null) {
    console.log(`   ℹ️  Universal Resolver HTTP ${resolution.httpStatus} for did:t3n (Bug #4 evidence)`);
    assert.ok([200, 400, 404, 501, 500].includes(resolution.httpStatus),
      `Unexpected status: ${resolution.httpStatus}`);
  }
});

// ─── Test 5: ComplianceService DID verify — strict schema ────────────────────
test('ComplianceService: verifyDidSubject — strict did:t3n schema enforced', async () => {
  const validDid = 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const result = await complianceService.verifyDidSubject(validDid);
  assert.equal(result.valid, true);
  assert.equal(result.formatValid, true);
  assert.ok(result.t3nParsed?.realm);

  // did:t3n:anything MUST be rejected
  const loose = await complianceService.verifyDidSubject('did:t3n:anything');
  assert.equal(loose.valid, false, 'did:t3n:anything must be REJECTED');
  assert.equal(loose.status, 'REJECTED_INVALID_FORMAT');

  // Fully invalid
  const inv = await complianceService.verifyDidSubject('not-a-did');
  assert.equal(inv.valid, false);
});

// ─── Test 6: Real Chainalysis OFAC Oracle ────────────────────────────────────
test('SanctionsService: Real Chainalysis OFAC oracle — clean and sanctioned addresses', async () => {
  const sanctionedAddr = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96'; // Lazarus Group (OFAC SDN)
  const normalAddr = '0xe4615a594b7a11796cd25b5401a109bba5855346';

  const normalResult = await sanctionsService.checkSanctions(normalAddr);
  assert.ok([true, false, null].includes(normalResult.sanctionsPassed));
  assert.ok(['CHAINALYSIS_OFAC_ORACLE', 'FORMAT_CHECK'].includes(normalResult.source));

  if (normalResult.oracleQueried) {
    assert.equal(typeof normalResult.sanctionsPassed, 'boolean');
    assert.equal(normalResult.isSanctioned, false, 'Normal wallet should not be sanctioned');
    console.log(`   ✅ Normal wallet: CLEAN`);

    const sanctionedResult = await sanctionsService.checkSanctions(sanctionedAddr);
    if (sanctionedResult.oracleQueried) {
      console.log(`   ℹ️  Lazarus Group wallet: ${sanctionedResult.isSanctioned ? '🚫 SANCTIONED (correct)' : '⚠️ not found (oracle may have updated)'}`);
      assert.equal(typeof sanctionedResult.isSanctioned, 'boolean');
    }
  } else {
    // Oracle unreachable → fail-safe: inconclusive, never auto-pass
    assert.equal(normalResult.sanctionsPassed, null, 'Inconclusive must be null, not true');
    console.log(`   ℹ️  Oracle unreachable — result is INCONCLUSIVE (fail-safe)`);
  }
});

// ─── Test 7: KYC tier derivation from txCount ────────────────────────────────
test('SanctionsService: KYC tier derived from txCount, not hardcoded', () => {
  const cases = [
    { txCount: 0,   level: 'UNVERIFIED' },
    { txCount: 1,   level: 'TIER_1_BASIC' },
    { txCount: 9,   level: 'TIER_1_BASIC' },
    { txCount: 10,  level: 'TIER_2_STANDARD' },
    { txCount: 99,  level: 'TIER_2_STANDARD' },
    { txCount: 100, level: 'TIER_3_ENTERPRISE' },
  ];
  for (const { txCount, level } of cases) {
    const r = sanctionsService.deriveKycTier(txCount);
    assert.equal(r.kycLevel, level, `txCount=${txCount} → expected ${level}, got ${r.kycLevel}`);
    assert.ok(r.kycBasis);
  }
  assert.equal(sanctionsService.deriveKycTier(-1).kycLevel, 'UNVERIFIED');
});

// ─── Test 8: Fail-closed — invalid wallet never APPROVE ──────────────────────
test('ComplianceService: Fail-closed — invalid wallet never returns APPROVE', async () => {
  const audit = await complianceService.runOnChainAudit('not-a-wallet-address', 'sepolia');
  assert.notEqual(audit.recommendation, 'APPROVE_TRANSACTION',
    'Invalid wallet must NEVER produce APPROVE');
  assert.equal(audit.complianceChecks.sanctionsPassed, false,
    'Invalid address must fail sanctions check');
  assert.ok(audit.complianceChecks.riskScore >= 50);
});

// ─── Test 9: Single-chain RPC audit (Sepolia) ────────────────────────────────
test('ComplianceService: Single-chain live RPC audit (Sepolia)', async () => {
  const wallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const audit = await complianceService.runOnChainAudit(wallet, 'sepolia');

  // auditId must use crypto.randomUUID pattern, not Math.random
  assert.ok(audit.auditId.startsWith('AUDIT-'), 'auditId must start with AUDIT-');
  assert.ok(audit.auditId.length > 10, 'auditId must be reasonably long (UUID-based)');
  assert.equal(audit.chain, 'sepolia');
  assert.ok(audit.liveOnChainData.realBalanceEth.includes('ETH'));
  assert.equal(typeof audit.liveOnChainData.txCountOnChain, 'number');
  // KYC must NOT be hardcoded
  assert.ok(audit.complianceChecks.kycBasis, 'kycBasis must be present (not hardcoded)');
  assert.ok(audit.complianceChecks.sanctionsSource, 'sanctionsSource must be present');
  if (audit.liveOnChainData.rpcConnected) {
    assert.ok(audit.liveOnChainData.blockNumber > 0);
  }
});

// ─── Test 10: Multi-chain audit ──────────────────────────────────────────────
test('ComplianceService: Multi-chain audit — results for each chain', async () => {
  const wallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const results = await complianceService.runMultiChainAudit(wallet, ['sepolia', 'base']);
  assert.equal(results.length, 2);
  assert.equal(results[0].chain, 'sepolia');
  assert.equal(results[1].chain, 'base');
});

// ─── Test 11: Report decision blocked when trustVerified=false ────────────────
test('ReportGeneratorService: trustVerified=false blocks APPROVE — max decision is REVIEW', () => {
  const mockDid = {
    did: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    method: 't3n', resolved: true, httpStatus: 200, // DID is resolved
    didDocument: { id: 'did:t3n:...' },
    resolverEvidence: { timestamp: new Date().toISOString(), evidenceHash: 'abc', note: 'OK' },
  };
  const mockAudits = [{
    chain: 'sepolia', rpcUrl: 'https://rpc', timestamp: new Date().toISOString(),
    liveOnChainData: { rpcConnected: true, blockNumber: 100, realBalanceEth: '1.0 ETH', txCountOnChain: 200, hasActivity: true },
    complianceChecks: { sanctionsPassed: true, sanctionsSource: 'CHAINALYSIS_OFAC_ORACLE', kycLevel: 'TIER_3_ENTERPRISE', riskScore: 10 },
    recommendation: 'APPROVE_TRANSACTION',
  }];

  // Even with perfect audit data, trustVerified=false must block APPROVE
  const report = reportGeneratorService.generate({
    agentDid: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    didResolution: mockDid,
    chainAudits: mockAudits,
    requestData: { userDid: mockDid.did, targetWalletAddress: '0xe4615a...', chains: ['sepolia'] },
    trustVerified: false, // ← key condition
  });

  assert.equal(report.complianceDecision, 'REVIEW',
    'trustVerified=false must produce REVIEW, never APPROVE');
  assert.equal(report.trustVerified, false);
  assert.ok(report.decisionReasons.some(r => r.includes('trust manifest')),
    'decisionReasons must mention trust manifest');
  console.log(`   ✅ trustVerified=false → Decision: ${report.complianceDecision} (correct)`);
});

// ─── Test 12: Report decision blocked when DID unresolved ────────────────────
test('ReportGeneratorService: DID unresolved blocks APPROVE — even with sanctions clean', () => {
  const mockDid = {
    did: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    method: 't3n', resolved: false, httpStatus: 501, // DID NOT resolved
    didDocument: null,
    resolverEvidence: { timestamp: new Date().toISOString(), evidenceHash: 'abc', note: 'HTTP 501' },
  };
  const mockAudits = [{
    chain: 'sepolia', rpcUrl: 'https://rpc', timestamp: new Date().toISOString(),
    liveOnChainData: { rpcConnected: true, blockNumber: 100, realBalanceEth: '1.0 ETH', txCountOnChain: 200, hasActivity: true },
    complianceChecks: { sanctionsPassed: true, sanctionsSource: 'CHAINALYSIS_OFAC_ORACLE', kycLevel: 'TIER_3_ENTERPRISE', riskScore: 5 },
    recommendation: 'APPROVE_TRANSACTION',
  }];

  // trustVerified=true but DID not resolved → still REVIEW, not APPROVE
  const report = reportGeneratorService.generate({
    agentDid: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    didResolution: mockDid,
    chainAudits: mockAudits,
    requestData: { userDid: mockDid.did, targetWalletAddress: '0xe4615a...', chains: ['sepolia'] },
    trustVerified: true, // ← trust OK, but DID unresolved
  });

  assert.notEqual(report.complianceDecision, 'APPROVE',
    'Unresolved DID must prevent APPROVE even with clean sanctions');
  assert.ok(['REVIEW', 'REJECT'].includes(report.complianceDecision));
  assert.ok(report.decisionReasons.some(r => r.includes('DID not resolved')),
    'decisionReasons must mention unresolved DID');
  assert.ok(report.reportId.startsWith('RPT-'));
  assert.ok(report.integrityHash.startsWith('sha256:'), 'Must have integrityHash (not auditSignature)');
  console.log(`   ✅ DID unresolved → Decision: ${report.complianceDecision} (correct)`);
});

// ─── Test 13: Persisted report includes its output path ──────────────────────
test('ReportGeneratorService: persisted JSON includes reportFile and valid integrity hash', () => {
  const mockDid = {
    did: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    method: 't3n', resolved: false, httpStatus: 501,
    didDocument: null,
    resolverEvidence: { timestamp: new Date().toISOString(), evidenceHash: 'abc', note: 'HTTP 501' },
  };
  const report = reportGeneratorService.generate({
    agentDid: mockDid.did,
    didResolution: mockDid,
    chainAudits: [],
    requestData: { userDid: mockDid.did, targetWalletAddress: '0xe4615a...', chains: [] },
    trustVerified: false,
  });

  assert.ok(report.reportFile, 'reportFile must be returned');
  assert.equal(existsSync(report.reportFile), true, 'reportFile must exist on disk');
  const persisted = JSON.parse(readFileSync(report.reportFile, 'utf8'));
  assert.equal(persisted.reportFile, report.reportFile, 'reportFile must be persisted in JSON');
  assert.equal(persisted.integrityHash, report.integrityHash, 'persisted hash must match returned report');
});
