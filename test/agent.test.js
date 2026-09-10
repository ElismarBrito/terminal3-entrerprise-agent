import test from 'node:test';
import assert from 'node:assert/strict';
import { T3EnterpriseAgent } from '../src/agent.js';
import { complianceService } from '../src/services/compliance.js';

test('T3EnterpriseAgent Initialization & Handshake Test', async () => {
  const agent = new T3EnterpriseAgent();
  assert.equal(agent.isInitialized, false);
  
  await agent.initialize();
  assert.equal(agent.isInitialized, true);
  assert.ok(agent.tenantDid.startsWith('did:t3n:'));
});

test('ComplianceService DID Format Verification Test', async () => {
  const validDid = 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC';
  const invalidDid = 'invalid:scheme:123';

  const validResult = await complianceService.verifyDidSubject(validDid);
  assert.equal(validResult.valid, true);
  assert.equal(validResult.status, 'VERIFIED_ENTERPRISE_DID');

  const invalidResult = await complianceService.verifyDidSubject(invalidDid);
  assert.equal(invalidResult.valid, false);
});

test('ComplianceService Live On-Chain Audit Test', async () => {
  const sampleWallet = '0xe4615a594b7a11796cd25b5401a109bba5855346';
  const auditRecord = await complianceService.runOnChainAudit(sampleWallet, 'sepolia');

  assert.ok(auditRecord.auditId.startsWith('AUDIT-'));
  assert.equal(auditRecord.walletAddress, sampleWallet);
  assert.ok(auditRecord.liveOnChainData.realBalanceEth.includes('ETH'));
  assert.equal(typeof auditRecord.liveOnChainData.txCountOnChain, 'number');
});
