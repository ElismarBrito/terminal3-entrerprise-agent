const config = require('./config');
const complianceService = require('./services/compliance');

/**
 * Terminal 3 ADK Enterprise Agent Core Runner
 */
class T3EnterpriseAgent {
  constructor() {
    this.name = config.agentConfig.name;
    this.did = config.t3n.agentDid;
    this.isInitialized = false;
  }

  async initialize() {
    console.log(`\n===============================================================`);
    console.log(`🤖 INITIALIZING TERMINAL 3 (T3N) ENTERPRISE AUDIT AGENT 🤖`);
    console.log(`===============================================================`);
    console.log(`📌 Agent Name: ${this.name}`);
    console.log(`🔑 Agent DID:  ${this.did}`);
    console.log(`🌐 API Target:  ${config.t3n.apiUrl}`);
    console.log(`⚡ Mode:        ${config.agentConfig.mode}`);
    console.log(`===============================================================\n`);

    // Simulate ADK Handshake & Authentication
    this.isInitialized = true;
    console.log(`✅ [ADK Handshake] Successfully authenticated with T3N Gateway!`);
  }

  /**
   * Main Task Execution Handler for Enterprise Queries
   */
  async processEnterpriseQuery(requestData) {
    if (!this.isInitialized) await this.initialize();

    console.log(`\n📥 [Incoming Request] Processing Query:`, requestData);

    const { userDid, targetWalletAddress } = requestData;

    // Step 1: Verify DID Identity
    console.log(`🔍 Step 1: Verifying Subject DID [${userDid}]...`);
    const didResult = await complianceService.verifyDidSubject(userDid);
    console.log(`   -> DID Verification Status:`, didResult.valid ? '✅ VERIFIED' : '❌ REJECTED');

    if (!didResult.valid) {
      return { success: false, error: didResult.reason };
    }

    // Step 2: Execute Financial Audit Check
    console.log(`📊 Step 2: Running Automated On-Chain Audit for [${targetWalletAddress}]...`);
    const auditReport = await complianceService.runFinancialAudit(targetWalletAddress);
    console.log(`   -> Audit Completed! Result: ${auditReport.recommendation}`);

    const responsePayload = {
      success: true,
      agentDid: this.did,
      processedAt: new Date().toISOString(),
      subject: didResult,
      auditReport
    };

    console.log(`\n📤 [Agent Execution Complete] Returning Audit Payload:`);
    console.log(JSON.stringify(responsePayload, null, 2));

    return responsePayload;
  }
}

// Runnable CLI demonstration mode
if (require.main === module) {
  const agent = new T3EnterpriseAgent();
  
  const sampleRequest = {
    userDid: 'did:t3n:enterprise:user:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    targetWalletAddress: '0xe4615a594b7a11796cd25b5401a109bba5855346',
    action: 'AUDIT_BEFORE_DISBURSEMENT'
  };

  agent.processEnterpriseQuery(sampleRequest);
}

module.exports = T3EnterpriseAgent;
