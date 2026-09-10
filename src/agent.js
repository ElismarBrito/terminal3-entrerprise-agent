import { config } from './config.js';
import { complianceService } from './services/compliance.js';
import { reportGeneratorService } from './services/report-generator.js';

let T3nSdkModule = null;
try {
  T3nSdkModule = await import('@terminal3/t3n-sdk');
} catch (e) {
  console.warn('ℹ️ [SDK Warning] @terminal3/t3n-sdk WASM component native loading in non-bundled ESM Node environment fallback active.');
}

/**
 * Terminal 3 ADK Production Enterprise Agent Engine
 *
 * Architecture:
 *   T3EnterpriseAgent
 *     ├── T3N ADK handshake (real enclave attempt, graceful fallback)
 *     ├── ComplianceService (DID verification + on-chain audit)
 *     │     ├── DIDResolverService (HTTP → DIF Universal Resolver)
 *     │     └── ethers.JsonRpcProvider (live RPC calls)
 *     └── ReportGeneratorService (structured JSON report → disk)
 */
export class T3EnterpriseAgent {
  constructor() {
    this.name = config.agent.name;
    this.agentDid = config.agent.agentDid;
    this.isInitialized = false;
    this.t3nClient = null;
    this.tenantDid = null;
    this.adkConnected = false;
  }

  /**
   * Initializes the T3N ADK connection.
   * Attempts a real enclave handshake; falls back to standalone mode with full logging.
   */
  async initialize() {
    console.log(`\n===============================================================`);
    console.log(`🤖 INITIALIZING TERMINAL 3 (T3N) ENTERPRISE AUDIT AGENT 🤖`);
    console.log(`===============================================================`);
    console.log(`📌 Agent Name: ${this.name}`);
    console.log(`🔑 Agent DID:  ${this.agentDid}`);
    console.log(`🌐 Target Env: ${config.t3n.environment}`);
    console.log(`===============================================================\n`);

    if (T3nSdkModule && typeof T3nSdkModule.setEnvironment === 'function') {
      try {
        T3nSdkModule.setEnvironment(config.t3n.environment);
        const apiKey = config.t3n.apiKey;
        const address = T3nSdkModule.eth_get_address(apiKey);

        console.log(`🔌 [T3N ADK] Attempting real enclave handshake...`);
        console.log(`   → ETH Address derived from API key: ${address}`);

        const wasmComponent = await T3nSdkModule.loadWasmComponent();
        console.log(`   → WASM enclave component loaded`);

        let trustAnchor;
        try {
          trustAnchor = await T3nSdkModule.fetchTrustedManifest(config.t3n.environment);
          console.log(`   → Trust manifest fetched from ${config.t3n.environment}`);
        } catch (err) {
          console.warn(`   ⚠️  fetchTrustedManifest failed (${err.message}) — using fallback trust anchor`);
          trustAnchor = config.t3n.fallbackTrustAnchor;
        }

        this.t3nClient = new T3nSdkModule.T3nClient({
          trustAnchor,
          wasmComponent,
          handlers: {
            EthSign: T3nSdkModule.metamask_sign(address, undefined, apiKey)
          }
        });

        await this.t3nClient.handshake();
        const authDid = await this.t3nClient.authenticate(T3nSdkModule.createEthAuthInput(address));
        this.tenantDid = authDid.value;
        this.adkConnected = true;
        console.log(`✅ [T3N ADK Connected] Authenticated Tenant DID: ${this.tenantDid}`);

      } catch (err) {
        // Full error logging for transparency and bug documentation
        console.warn(`⚠️ [ADK Fallback] Real enclave connection handshake fallback: ${err.message}`);
        if (err.stack) {
          console.warn(`   Stack: ${err.stack.split('\n')[1]?.trim() || 'N/A'}`);
        }
        console.warn(`   → Operating in standalone mode (DID: ${this.agentDid})`);
        this.tenantDid = this.agentDid;
        this.adkConnected = false;
      }
    } else {
      this.tenantDid = this.agentDid;
      this.adkConnected = false;
      console.log(`✅ [ADK Standalone Mode] Operating as Enterprise Agent DID: ${this.tenantDid}`);
    }

    this.isInitialized = true;
  }

  /**
   * Main enterprise compliance workflow:
   *   1. Verify subject DID (format + real HTTP resolution attempt)
   *   2. Multi-chain on-chain financial audit
   *   3. Generate and persist structured compliance report
   *
   * @param {object} requestData - { userDid, targetWalletAddress, chains? }
   * @returns {Promise<ComplianceReport>}
   */
  async processEnterpriseQuery(requestData) {
    if (!this.isInitialized) await this.initialize();

    console.log(`\n📥 [Incoming Query] Enterprise Disbursement Audit Request:`);
    console.log(`   Subject DID:    ${requestData.userDid}`);
    console.log(`   Wallet Address: ${requestData.targetWalletAddress}`);
    console.log(`   Chains:         ${(requestData.chains || ['sepolia']).join(', ')}`);

    const { userDid, targetWalletAddress, chains = ['sepolia'] } = requestData;

    // ── Step 1: Real DID Verification ────────────────────────────────────────
    console.log(`\n🔍 Step 1: DID Verification [${userDid}]`);
    const didResult = await complianceService.verifyDidSubject(userDid);
    console.log(`   → Format Valid: ${didResult.formatValid ? '✅' : '❌'}`);
    console.log(`   → Resolved:     ${didResult.resolved ? '✅ YES' : `❌ NO (HTTP ${didResult.httpStatus || 'N/A'})`}`);
    console.log(`   → Status:       ${didResult.status}`);

    if (!didResult.valid) {
      return { success: false, error: didResult.reason, requestData };
    }

    // ── Step 2: Multi-Chain On-Chain Audit ───────────────────────────────────
    console.log(`\n📊 Step 2: Multi-Chain RPC Audit [${targetWalletAddress}] on [${chains.join(', ')}]`);
    const chainAudits = await complianceService.runMultiChainAudit(targetWalletAddress, chains);

    for (const audit of chainAudits) {
      console.log(`   [${audit.chain.toUpperCase()}] Block: ${audit.liveOnChainData.blockNumber ?? 'N/A'} | Balance: ${audit.liveOnChainData.realBalanceEth} | Txs: ${audit.liveOnChainData.txCountOnChain}`);
    }

    // ── Step 3: Generate Structured Report ───────────────────────────────────
    console.log(`\n📝 Step 3: Generating Structured Compliance Report`);
    const report = reportGeneratorService.generate({
      agentDid: this.tenantDid || this.agentDid,
      didResolution: didResult,
      chainAudits,
      requestData,
    });

    console.log(`   → Report ID:   ${report.reportId}`);
    console.log(`   → Decision:    ${report.complianceDecision}`);
    console.log(`   → Risk Score:  ${report.riskScore}/100`);
    console.log(`   → Signature:   ${report.auditSignature}`);

    const responsePayload = {
      success: true,
      agentDid: this.tenantDid || this.agentDid,
      adkConnected: this.adkConnected,
      processedAt: new Date().toISOString(),
      report,
    };

    console.log(`\n✅ [Execution Complete] Compliance Report Generated:`);
    console.log(JSON.stringify(responsePayload.report.summary, null, 2));

    return responsePayload;
  }
}

// ── Runnable CLI demonstration mode ──────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('agent.js')) {
  const agent = new T3EnterpriseAgent();

  const sampleRequest = {
    userDid: 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    targetWalletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346',
    chains: ['sepolia', 'base'],
  };

  agent.processEnterpriseQuery(sampleRequest);
}
