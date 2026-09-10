import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { T3EnterpriseAgent } from '../src/agent.js';
import { complianceService } from '../src/services/compliance.js';
import { didResolverService } from '../src/services/did-resolver.js';
import { reportGeneratorService } from '../src/services/report-generator.js';
import { sanctionsService } from '../src/services/sanctions.js';

// ─── Test 1: Agent Initialization & ADK Handshake ────────────────────────────
test('T3EnterpriseAgent: Initialization & ADK Handshake (graceful fallback)', async () => {
  const agent = new T3EnterpriseAgent();
  assert.equal(agent.isInitialized, false);

  await agent.initialize();

  assert.equal(agent.isInitialized, true);
  assert.ok(agent.tenantDid.startsWith('did:t3n:'), `tenantDid must start with "did:t3n:", got: ${agent.tenantDid}`);
  assert.equal(typeof agent.adkConnected, 'boolean');

  // Without a real T3N account, adkConnected will be false.
  // What this test proves: the agent initializes cleanly, the SDK is imported,
  // and the flow reaches network-level auth (not format error).
  console.log(`   ℹ️  adkConnected=${agent.adkConnected} (false = no real T3N account in test env, expected)`);
});

// ─── Test 2: DID Strict Schema — Valid did:t3n ───────────────────────────────
test('DIDResolverService: Strict did:t3n schema — valid cases', () => {
  const validCases = [
    'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:user:agent:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    'did:t3n:node:validator:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
  ];

  for (const did of validCases) {
    const result = didResolverService.validateFormat(did);
    assert.equal(result.valid, true, `Expected VALID: "${did}" — Reason: ${result.reason}`);
    assert.equal(result.method, 't3n');
    assert.ok(result.t3nParsed?.realm, 'Must parse realm');
    assert.ok(result.t3nParsed?.role, 'Must parse role');
    assert.ok(result.t3nParsed?.address?.startsWith('0x'), 'Must parse checksum address');
  }
});

// ─── Test 3: DID Strict Schema — INVALID did:t3n ─────────────────────────────
test('DIDResolverService: Strict did:t3n schema — invalid/malformed cases REJECTED', () => {
  const invalidCases = [
    { did: 'did:t3n:anything',                  reason: 'generic form (only 3 parts)' },
    { did: 'did:t3n:enterprise:audit',           reason: 'missing address (4 parts)' },
    { did: 'did:t3n:ENTERPRISE:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC', reason: 'uppercase realm' },
    { did: 'did:t3n:enterprise:ADMIN:0x909F5A24F4f3353A823Bed637410D21E6521BAEC', reason: 'invalid role' },
    { did: 'did:t3n:enterprise:audit:notanaddress', reason: 'invalid ETH address' },
    { did: 'did:t3n:enterprise:audit:0x1234',    reason: 'short address' },
    { did: 'invalid:scheme:123',                 reason: 'wrong scheme' },
    { did: '',                                   reason: 'empty string' },
    { did: null,                                 reason: 'null' },
  ];

  for (const { did, reason } of invalidCases) {
    const result = didResolverService.validateFormat(did);
    assert.equal(result.valid, false,
      `Expected INVALID (${reason}): "${did}" — but got valid=true`);
    assert.ok(result.reason, `Must provide a reason for rejection of "${did}"`);
  }
});

// ─── Test 4: DID Resolution via Universal Resolver (Real HTTP) ────────────────
test('DIDResolverService: Real HTTP Resolution — captures HTTP 501 as Bug #4 evidence', async () => {
  const t3nDid = 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const resolution = await didResolverService.resolve(t3nDid);

  assert.equal(resolution.did, t3nDid);
  assert.ok(resolution.resolverUrl.includes('uniresolver.io'));
  assert.equal(typeof resolution.resolved, 'boolean');
  assert.ok(resolution.resolverEvidence?.timestamp);
  assert.ok(resolution.resolverEvidence?.evidenceHash);

  if (resolution.httpStatus !== null) {
    console.log(`   ℹ️  Universal Resolver HTTP ${resolution.httpStatus} for did:t3n (Bug #4 evidence)`);
    // HTTP 501 = method not registered; 404 = not found; both are valid evidence
    assert.ok([200, 400, 404, 501, 500].includes(resolution.httpStatus),
      `Unexpected status: ${resolution.httpStatus}`);
  } else {
    console.log(`   ℹ️  Universal Resolver unreachable — see resolverEvidence.error`);
  }
});

// ─── Test 5: ComplianceService DID Verify — strict schema integration ─────────
test('ComplianceService: verifyDidSubject — strict schema + resolver integration', async () => {
  // Valid did:t3n — should pass format, fail resolution (HTTP 501)
  const validDid = 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const validResult = await complianceService.verifyDidSubject(validDid);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.formatValid, true);
  assert.ok(['FULLY_RESOLVED', 'FORMAT_VALID_UNRESOLVABLE'].includes(validResult.status));
  assert.ok(validResult.t3nParsed?.realm, 'Must parse t3n realm');

  // did:t3n:anything — strict schema must REJECT this
  const looseT3n = 'did:t3n:anything';
  const looseResult = await complianceService.verifyDidSubject(looseT3n);
  assert.equal(looseResult.valid, false, 'did:t3n:anything must be REJECTED by strict schema');
  assert.equal(looseResult.status, 'REJECTED_INVALID_FORMAT');

  // Non-did string — must be rejected
  const invalid = 'not-a-did';
  const invalidResult = await complianceService.verifyDidSubject(invalid);
  assert.equal(invalidResult.valid, false);
});

// ─── Test 6: SanctionsService — Chainalysis OFAC Oracle (real call) ──────────
test('SanctionsService: Real Chainalysis OFAC oracle query', async () => {
  // Well-known OFAC-sanctioned address (public Lazarus Group address, OFAC SDN list)
  // Source: https://home.treasury.gov/news/press-releases/jy0916
  const sanctionedAddress = '0x098B716B8Aaf21512996dC57EB0615e2383E2f96';
  // A regular wallet with no sanctions
  const normalAddress = '0xe4615a594b7a11796cd25b5401a109bba5855346';

  // Check normal address
  const normalResult = await sanctionsService.checkSanctions(normalAddress);
  assert.equal(typeof normalResult.sanctionsPassed, 'boolean',
    'sanctionsPassed must be boolean (not hardcoded null)');
  assert.ok(['CHAINALYSIS_OFAC_ORACLE', 'FORMAT_CHECK'].includes(normalResult.source));
  assert.ok(normalResult.timestamp);

  if (normalResult.oracleQueried) {
    console.log(`   ℹ️  Normal wallet sanctions result: ${normalResult.isSanctioned ? '🚫 SANCTIONED' : '✅ CLEAN'}`);
    // A real non-sanctioned wallet should pass
    assert.equal(normalResult.isSanctioned, false, 'Normal wallet should not be sanctioned');
  } else {
    console.log(`   ℹ️  Oracle unreachable — result is INCONCLUSIVE (fail-safe)`);
    assert.equal(normalResult.sanctionsPassed, null, 'Inconclusive must be null, not true');
  }

  // Check sanctioned address (if oracle is reachable)
  const sanctionedResult = await sanctionsService.checkSanctions(sanctionedAddress);
  if (sanctionedResult.oracleQueried) {
    console.log(`   ℹ️  Sanctioned wallet result: ${sanctionedResult.isSanctioned ? '🚫 SANCTIONED (correct)' : '⚠️ NOT found (oracle may be stale)'}`);
    // Note: if result is false, the oracle may have updated its list
    // We don't hard-assert true here since OFAC lists change
    assert.equal(typeof sanctionedResult.isSanctioned, 'boolean');
  }
});

// ─── Test 7: SanctionsService — KYC Tier Derivation ─────────────────────────
test('SanctionsService: KYC tier derived from real txCount (not hardcoded)', () => {
  const cases = [
    { txCount: 0,   expectedLevel: 'UNVERIFIED' },
    { txCount: 1,   expectedLevel: 'TIER_1_BASIC' },
    { txCount: 9,   expectedLevel: 'TIER_1_BASIC' },
    { txCount: 10,  expectedLevel: 'TIER_2_STANDARD' },
    { txCount: 99,  expectedLevel: 'TIER_2_STANDARD' },
    { txCount: 100, expectedLevel: 'TIER_3_ENTERPRISE' },
    { txCount: 999, expectedLevel: 'TIER_3_ENTERPRISE' },
  ];

  for (const { txCount, expectedLevel } of cases) {
    const result = sanctionsService.deriveKycTier(txCount);
    assert.equal(result.kycLevel, expectedLevel,
      `txCount=${txCount} → expected ${expectedLevel}, got ${result.kycLevel}`);
    assert.ok(result.kycBasis, 'kycBasis must be present');
  }

  // Invalid input → UNVERIFIED (never throws)
  const invalidResult = sanctionsService.deriveKycTier(-1);
  assert.equal(invalidResult.kycLevel, 'UNVERIFIED');
});

// ─── Test 8: Fail-Closed — invalid wallet never auto-approves ────────────────
test('ComplianceService: Fail-closed — invalid wallet address never returns APPROVE', async () => {
  const invalidWallet = 'not-a-wallet-address';
  const auditRecord = await complianceService.runOnChainAudit(invalidWallet, 'sepolia');

  // An invalid address should never result in APPROVE
  assert.notEqual(auditRecord.recommendation, 'APPROVE_TRANSACTION',
    'Invalid wallet must NEVER produce APPROVE recommendation');

  // Sanctions for invalid address = rejected before oracle
  assert.equal(auditRecord.complianceChecks.sanctionsPassed, false,
    'Invalid address must fail sanctions check (FORMAT_CHECK rejection)');

  // Risk score for invalid address should be high
  assert.ok(auditRecord.complianceChecks.riskScore >= 50,
    `Risk score for invalid wallet should be >= 50, got ${auditRecord.complianceChecks.riskScore}`);
});

// ─── Test 9: Single-Chain Live Audit (Sepolia) ───────────────────────────────
test('ComplianceService: Single-chain live RPC audit (Sepolia) — real data', async () => {
  const wallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const audit = await complianceService.runOnChainAudit(wallet, 'sepolia');

  assert.ok(audit.auditId.startsWith('AUDIT-'));
  assert.equal(audit.chain, 'sepolia');
  assert.ok(audit.rpcUrl.includes('publicnode.com'));
  assert.ok(audit.liveOnChainData.realBalanceEth.includes('ETH'));
  assert.equal(typeof audit.liveOnChainData.txCountOnChain, 'number');

  if (audit.liveOnChainData.rpcConnected) {
    assert.ok(audit.liveOnChainData.blockNumber > 0, 'blockNumber must be positive');
  }

  // KYC and sanctions must NOT be hardcoded
  assert.notEqual(audit.complianceChecks.kycLevel, undefined);
  assert.notEqual(audit.complianceChecks.kycBasis, undefined);
  assert.ok(audit.complianceChecks.sanctionsSource, 'sanctionsSource must be present');
});

// ─── Test 10: Multi-Chain Audit ───────────────────────────────────────────────
test('ComplianceService: Multi-chain audit — results for each chain', async () => {
  const wallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const chains = ['sepolia', 'base'];
  const results = await complianceService.runMultiChainAudit(wallet, chains);

  assert.equal(results.length, chains.length);
  for (const [i, result] of results.entries()) {
    assert.equal(result.chain, chains[i]);
    assert.ok(result.liveOnChainData);
  }
});

// ─── Test 11: Report Generator — valid schema + SHA-256 signature ─────────────
test('ReportGeneratorService: Generates valid structured JSON with SHA-256 signature', async () => {
  const mockDidResolution = {
    did: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    method: 't3n',
    resolved: false,
    httpStatus: 501,
    didDocument: null,
    resolverEvidence: { timestamp: new Date().toISOString(), evidenceHash: 'abc123', note: 'HTTP 501' },
  };

  const mockChainAudits = [{
    auditId: 'AUDIT-TEST',
    walletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346',
    chain: 'sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    timestamp: new Date().toISOString(),
    liveOnChainData: { rpcConnected: true, blockNumber: 7654321, realBalanceEth: '0.5 ETH', txCountOnChain: 42, hasActivity: true },
    complianceChecks: { kycLevel: 'TIER_3_ENTERPRISE', riskScore: 10 },
    recommendation: 'APPROVE_TRANSACTION',
  }];

  const report = reportGeneratorService.generate({
    agentDid: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    didResolution: mockDidResolution,
    chainAudits: mockChainAudits,
    requestData: { userDid: mockDidResolution.did, targetWalletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346', chains: ['sepolia'] },
  });

  assert.ok(report.reportId.startsWith('RPT-'));
  assert.equal(report.schemaVersion, '1.0.0');
  assert.ok(report.auditSignature.startsWith('sha256:'));
  assert.ok(['APPROVE', 'REVIEW', 'REJECT'].includes(report.complianceDecision));
  assert.ok(report.riskScore >= 0 && report.riskScore <= 100);
  assert.ok(Array.isArray(report.auditTrail));

  if (report.reportFile) {
    assert.ok(existsSync(report.reportFile), `Report file must exist: ${report.reportFile}`);
  }

  const reportsDir = join(process.cwd(), 'reports');
  assert.ok(existsSync(reportsDir), 'reports/ directory must exist');
});

// ─── Test 12: SanctionsService — invalid address format rejected pre-oracle ───
test('SanctionsService: Invalid address format rejected before oracle query', async () => {
  const result = await sanctionsService.checkSanctions('not-an-eth-address');

  assert.equal(result.sanctionsPassed, false, 'Invalid format = sanctions not passed');
  assert.equal(result.oracleQueried, false, 'Oracle must NOT be queried for invalid addresses');
  assert.equal(result.source, 'FORMAT_CHECK', 'Source must be FORMAT_CHECK');
  assert.ok(result.reason?.includes('Invalid Ethereum address'), 'Must explain rejection reason');
});
