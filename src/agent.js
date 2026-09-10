import { config } from './config.js';
import { complianceService } from './services/compliance.js';

let T3nSdkModule = null;
try {
  T3nSdkModule = await import('@terminal3/t3n-sdk');
} catch (e) {
  console.warn('ℹ️ [SDK Warning] @terminal3/t3n-sdk WASM component native loading in non-bundled ESM Node environment fallback active.');
}

/**
 * Terminal 3 ADK Production Enterprise Agent Engine
 */
export class T3EnterpriseAgent {
  constructor() {
    this.name = config.agent.name;
    this.agentDid = config.agent.agentDid;
    this.isInitialized = false;
    this.t3nClient = null;
    this.tenantDid = null;
  }

  /**
   * Initializes real T3N Client connection using Terminal 3 ADK Quickstart spec
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
        const wasmComponent = await T3nSdkModule.loadWasmComponent();
        
        let trustAnchor;
        try {
          trustAnchor = await T3nSdkModule.fetchTrustedManifest(config.t3n.environment);
        } catch (err) {
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
        console.log(`✅ [T3N ADK Connected] Authenticated Tenant DID:`, this.tenantDid);
      } catch (err) {
        console.warn(`⚠️ [ADK Fallback] Real enclave connection handshake fallback: ${err.message}`);
        this.tenantDid = this.agentDid;
      }
    } else {
      this.tenantDid = this.agentDid;
      console.log(`✅ [ADK Standalone Mode] Operating as Enterprise Agent DID:`, this.tenantDid);
    }

    this.isInitialized = true;
  }

  /**
   * Enterprise Audit & Compliance Execution Handler
   */
  async processEnterpriseQuery(requestData) {
    if (!this.isInitialized) await this.initialize();

    console.log(`\n📥 [Incoming Query] Processing Enterprise Disbursement Audit Request:`, requestData);
    const { userDid, targetWalletAddress, chain = 'sepolia' } = requestData;

    // Step 1: Real DID Verification
    console.log(`🔍 Step 1: Verifying Subject DID [${userDid}]...`);
    const didResult = await complianceService.verifyDidSubject(userDid);
    console.log(`   -> Status:`, didResult.valid ? '✅ VERIFIED' : '❌ INVALID');

    if (!didResult.valid) {
      return { success: false, error: didResult.reason };
    }

    // Step 2: Real On-Chain RPC Financial Footprint Audit
    console.log(`📊 Step 2: Executing Live On-Chain RPC Audit for [${targetWalletAddress}] on [${chain}]...`);
    const auditReport = await complianceService.runOnChainAudit(targetWalletAddress, chain);
    console.log(`   -> Live Balance: ${auditReport.liveOnChainData.realBalanceEth}`);
    console.log(`   -> On-Chain Txs:  ${auditReport.liveOnChainData.txCountOnChain}`);
    console.log(`   -> Recommendation: ${auditReport.recommendation}`);

    const responsePayload = {
      success: true,
      agentDid: this.tenantDid || this.agentDid,
      processedAt: new Date().toISOString(),
      subjectDid: didResult,
      auditReport
    };

    console.log(`\n📤 [Execution Complete] Output Payload Generated:`);
    console.log(JSON.stringify(responsePayload, null, 2));

    return responsePayload;
  }
}

// Runnable CLI demonstration mode
if (process.argv[1] && process.argv[1].endsWith('agent.js')) {
  const agent = new T3EnterpriseAgent();
  
  const sampleRequest = {
    userDid: 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    targetWalletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346',
    chain: 'sepolia'
  };

  agent.processEnterpriseQuery(sampleRequest);
}
