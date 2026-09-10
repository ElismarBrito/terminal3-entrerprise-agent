import { config } from './config.js';
import { complianceService } from './services/compliance.js';
import { reportGeneratorService } from './services/report-generator.js';

let T3nSdkModule = null;
try {
  T3nSdkModule = await import('@terminal3/t3n-sdk');
} catch (e) {
  console.warn('ℹ️ [SDK Warning] @terminal3/t3n-sdk could not be loaded.');
}

/**
 * Terminal 3 ADK Enterprise Agent
 *
 * Trust verification chain:
 *   1. loadWasmComponent()        — loads the TEE enclave WASM binary
 *   2. fetchTrustedManifest()     — fetches signed trust anchor from T3N cluster
 *                                   ⚠️ KNOWN BUG #2: returns malformed manifest on testnet
 *   3. T3nClient.handshake()      — establishes secure channel with enclave
 *   4. T3nClient.authenticate()   — authenticates ETH identity, returns tenantDid
 *
 * trustVerified = true only when ALL 4 steps succeed without falling back.
 * When trustVerified = false, the report generator blocks APPROVE decisions.
 */
export class T3EnterpriseAgent {
  constructor() {
    this.name = config.agent.name;
    this.agentDid = config.agent.agentDid;
    this.isInitialized = false;
    this.t3nClient = null;
    this.tenantDid = null;
    this.adkConnected = false;
    this.trustVerified = false; // true only when trust manifest was fetched & verified
  }

  async initialize() {
    console.log(`\n===============================================================`);
    console.log(`🤖 INITIALIZING TERMINAL 3 (T3N) ENTERPRISE AUDIT AGENT`);
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
        console.log(`   → ETH Address: ${address}`);

        const wasmComponent = await T3nSdkModule.loadWasmComponent();
        console.log(`   → WASM enclave component loaded ✅`);

        // Step 2: Fetch and verify trust manifest
        let trustAnchor;
        let manifestVerified = false;
          try {
            trustAnchor = await T3nSdkModule.fetchTrustedManifest(config.t3n.environment);
            manifestVerified = true;
            console.log(`   → Trust manifest fetched and verified ✅`);
          } catch (err) {
            // The SDK currently returns a malformed manifest on testnet. The
            // unsafe fallback is allowed only for local/test development; it
            // must never silently weaken production trust verification.
            console.warn(`   ⚠️  fetchTrustedManifest FAILED: ${err.message}`);
            console.warn(`   ⚠️  Trust manifest unavailable from ${config.t3n.environment} cluster.`);
            if (!config.t3n.allowUnsafeTrustFallback) {
              throw new Error(`T3N trust manifest verification failed and unsafe fallback is disabled: ${err.message}`);
            }
            console.warn(`   ⚠️  Using development-only fallback trust anchor — trustVerified remains false.`);
            console.warn(`   ⚠️  APPROVE decisions will be blocked until the manifest is valid.`);
            trustAnchor = config.t3n.fallbackTrustAnchor;
            manifestVerified = false;
          }

        this.t3nClient = new T3nSdkModule.T3nClient({
          trustAnchor,
          wasmComponent,
          handlers: {
            EthSign: T3nSdkModule.metamask_sign(address, undefined, apiKey),
          },
        });

        await this.t3nClient.handshake();
        console.log(`   → Enclave handshake complete ✅`);

        const authDid = await this.t3nClient.authenticate(
          T3nSdkModule.createEthAuthInput(address)
        );
        this.tenantDid = authDid.value;
        this.adkConnected = true;
        // trustVerified requires BOTH successful auth AND a valid manifest
        this.trustVerified = manifestVerified;

        console.log(`✅ [T3N ADK] Authenticated — Tenant DID: ${this.tenantDid}`);
        console.log(`   adkConnected:  ${this.adkConnected}`);
        console.log(`   trustVerified: ${this.trustVerified} ${!this.trustVerified ? '⚠️  (manifest fallback — APPROVE blocked)' : '✅'}`);

      } catch (err) {
        console.warn(`⚠️ [ADK] Handshake failed: ${err.message}`);
        this.tenantDid = this.agentDid;
        this.adkConnected = false;
        this.trustVerified = false;
      }
    } else {
      this.tenantDid = this.agentDid;
      this.adkConnected = false;
      this.trustVerified = false;
      console.log(`ℹ️  [ADK] SDK not loaded — standalone mode (adkConnected: false, trustVerified: false)`);
    }

    this.isInitialized = true;
  }

  /**
   * Main compliance workflow.
   * trustVerified is passed through to the report generator, which enforces
   * that unverified trust anchor cannot produce APPROVE decisions.
   */
  async processEnterpriseQuery(requestData) {
    if (!this.isInitialized) await this.initialize();

    console.log(`\n📥 [Query] Enterprise Audit Request:`);
    console.log(`   Subject DID:    ${requestData.userDid}`);
    console.log(`   Wallet:         ${requestData.targetWalletAddress}`);
    console.log(`   Chains:         ${(requestData.chains || ['sepolia']).join(', ')}`);
    console.log(`   trustVerified:  ${this.trustVerified}`);

    const { userDid, targetWalletAddress, chains = ['sepolia'] } = requestData;

    console.log(`\n🔍 Step 1: DID Verification`);
    const didResult = await complianceService.verifyDidSubject(userDid);
    console.log(`   → Format:   ${didResult.formatValid ? '✅ Valid' : '❌ Invalid'}`);
    console.log(`   → Resolved: ${didResult.resolved ? '✅' : `❌ NO (HTTP ${didResult.httpStatus || 'N/A'})`}`);
    console.log(`   → Status:   ${didResult.status}`);

    if (!didResult.valid) {
      return { success: false, error: didResult.reason, requestData };
    }

    console.log(`\n📊 Step 2: Multi-Chain Audit`);
    const chainAudits = await complianceService.runMultiChainAudit(targetWalletAddress, chains);
    for (const a of chainAudits) {
      console.log(`   [${a.chain.toUpperCase()}] Block: ${a.liveOnChainData.blockNumber ?? 'N/A'} | Balance: ${a.liveOnChainData.realBalanceEth} | Txs: ${a.liveOnChainData.txCountOnChain} | Sanctions: ${a.complianceChecks.sanctionsPassed === true ? '✅ Clean' : a.complianceChecks.sanctionsPassed === false ? '🚫 FLAGGED' : '⚠️ Inconclusive'}`);
    }

    console.log(`\n📝 Step 3: Generating Compliance Report`);
    const report = reportGeneratorService.generate({
      agentDid: this.tenantDid || this.agentDid,
      didResolution: didResult,
      chainAudits,
      requestData,
      trustVerified: this.trustVerified,
    });

    console.log(`   → Report ID:   ${report.reportId}`);
    console.log(`   → Decision:    ${report.complianceDecision}`);
    console.log(`   → Risk Score:  ${report.riskScore}/100`);
    console.log(`   → Reasons:     ${report.decisionReasons.join(' | ')}`);
    console.log(`   → Integrity:   ${report.integrityHash}`);

    return {
      success: true,
      agentDid: this.tenantDid || this.agentDid,
      adkConnected: this.adkConnected,
      trustVerified: this.trustVerified,
      processedAt: new Date().toISOString(),
      report,
    };
  }
}

if (process.argv[1] && process.argv[1].endsWith('agent.js')) {
  const agent = new T3EnterpriseAgent();
  agent.processEnterpriseQuery({
    userDid: 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    targetWalletAddress: '0xE4615a594b7a11796CD25B5401a109bbA5855346',
    chains: ['sepolia', 'base'],
  });
}
