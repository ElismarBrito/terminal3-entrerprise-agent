# T3N Enterprise Financial Audit & Compliance Agent

> **Terminal 3 (T3N) ADK Community Bounty Submission**  
> An **advanced prototype** of an enterprise agent for real-time DID verification, on-chain financial auditing, and sanctions compliance via the Chainalysis OFAC Oracle.

> [!NOTE]
> **Known Limitations:** This is an advanced prototype, not a production-grade system. A real `T3N_API_KEY` is required for production. The current testnet trust manifest is malformed upstream, so development mode uses an explicitly marked unsafe fallback and always blocks `APPROVE` decisions. Sanctions checking uses the Chainalysis OFAC Oracle (real, on-chain) but does not cover AML/mixer exposure. KYC tiers are derived from transaction counts, not a certified KYC provider.

---

## 📐 Architecture

```
┌─────────────────────────────────────────────────────────────┐
│               T3EnterpriseAgent (src/agent.js)              │
│                                                             │
│  ┌──────────────────┐   ┌───────────────────────────────┐  │
│  │  T3N ADK         │   │  ComplianceService             │  │
│  │  Handshake       │   │  (src/services/compliance.js)  │  │
│  │  (real enclave   │   │                               │  │
│  │   attempt with   │   │  ┌─────────────────────────┐  │  │
│  │   fallback)      │   │  │ DIDResolverService       │  │  │
│  └──────────────────┘   │  │ HTTP → DIF Universal     │  │  │
│                         │  │ Resolver (uniresolver.io)│  │  │
│                         │  └─────────────────────────┘  │  │
│                         │                               │  │
│                         │  ┌─────────────────────────┐  │  │
│                         │  │ Multi-Chain RPC Audit    │  │  │
│                         │  │ ethers.JsonRpcProvider   │  │  │
│                         │  │ Sepolia │ Base │ Monad   │  │  │
│                         │  └─────────────────────────┘  │  │
│                         └───────────────────────────────┘  │
│                                                             │
│  ┌──────────────────────────────────────────────────────┐  │
│  │  ReportGeneratorService (src/services/report-         │  │
│  │  generator.js) → reports/audit-RPT-*.json            │  │
│  │  SHA-256 signed structured compliance report          │  │
│  └──────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 🚀 How to Run

### Prerequisites
- Node.js 18+
- npm

### Setup
```bash
git clone https://github.com/ElismarBrito/terminal3-entrerprise-agent
cd terminal3-entrerprise-agent
npm install
```

### Run the Agent (CLI Demo Mode)
```bash
node src/agent.js
```

**Expected output:**
```
===============================================================
🤖 INITIALIZING TERMINAL 3 (T3N) ENTERPRISE AUDIT AGENT 🤖
===============================================================
📌 Agent Name: T3N Enterprise Financial Audit & Compliance Agent
🔑 Agent DID:  did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC
🌐 Target Env: testnet
===============================================================

🔍 Step 1: DID Verification [did:t3n:enterprise:user:0x...]
   🌐 [DID Resolver] Querying Universal Resolver: https://dev.uniresolver.io/...
   → Resolved: ❌ NO (HTTP 404)   ← Bug #4 evidence

📊 Step 2: Multi-Chain RPC Audit [0xe461...] on [sepolia, base]
   [SEPOLIA] Block: 7654321 | Balance: 0.0 ETH | Txs: 3

📝 Step 3: Generating Structured Compliance Report
   → Report ID:  RPT-XXXXXX
   → Decision:   REVIEW
   → Risk Score: 30/100
   → Signature:  sha256:abc123...

📁 [Report Generator] Structured report saved: reports/audit-RPT-XXXXXX-*.json
```

### Run Tests
```bash
npm test
```

**Expected output (13/13 tests passing):**
```
✔ T3EnterpriseAgent: Initialization & ADK Handshake
✔ DIDResolverService: Format Validation (valid and invalid)
✔ DIDResolverService: Real HTTP Resolution via Universal Resolver
✔ ComplianceService: verifyDidSubject with real resolver integration
✔ ComplianceService: Single-Chain Live On-Chain Audit (Sepolia)
✔ ComplianceService: Multi-Chain Audit returns results for each chain
✔ ReportGeneratorService: Generates valid structured JSON report with signature
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

---

## 📁 Project Structure

```
terminal3-enterprise-agent/
├── src/
│   ├── agent.js                      # Main agent engine (T3N ADK + orchestration)
│   ├── config.js                     # Environment configuration
│   └── services/
│       ├── compliance.js             # DID verification + RPC audit orchestrator
│       ├── did-resolver.js           # Real HTTP DID resolution (DIF Universal Resolver)
│       └── report-generator.js       # Structured JSON report with SHA-256 signature
├── test/
│   └── agent.test.js                 # 13 automated tests (Node.js test runner)
├── reports/                          # Auto-generated audit JSON reports
├── BUG_REPORTS_AND_FEEDBACK.md       # 5 verified bugs + 2 DX improvements
├── SUBMISSION_DOCUMENTATION.md       # Full submission documentation
└── package.json                      # ESM, dependencies, npm scripts
```

---

## 🔗 Key Features

| Feature | Implementation |
|---|---|
| **T3N ADK Integration** | Real enclave handshake attempt via `@terminal3/t3n-sdk@5.2.0` |
| **DID Verification** | W3C format validation + HTTP call to DIF Universal Resolver |
| **On-Chain Audit** | Live RPC calls via `ethers.js` (balance, txCount, blockNumber) |
| **Multi-Chain** | Concurrent audits on Sepolia, Base, Monad |
| **Structured Reports** | JSON reports with SHA-256 integrity signature, saved to disk |
| **Bug Evidence** | HTTP 404 from Universal Resolver for `did:t3n` (Bug #4) |
| **Tests** | 13 automated tests with Node.js built-in test runner |

---

## 📋 Environment Variables (optional)

```env
T3N_API_KEY=your_real_t3n_api_key
T3N_ENV=testnet
T3N_AGENT_DID=did:t3n:enterprise:audit:0x...
# Optional: configure a Terminal3-native DID resolver when available
T3N_DID_RESOLVER_URL=https://dev.uniresolver.io/1.0/identifiers/
# Development only; production always disables unsafe trust fallback
T3N_ALLOW_UNSAFE_TRUST_FALLBACK=true
```

### Production safety

When `NODE_ENV=production`, the agent requires a real `T3N_API_KEY` and refuses to use the unsafe trust-anchor fallback. If the upstream trust manifest cannot be verified, initialization fails closed instead of creating a potentially trusted session. In testnet development, the fallback may be used only to exercise the rest of the workflow; reports remain capped at `REVIEW`.

The DIF Universal Resolver currently returns HTTP 501 for `did:t3n` because no public resolver driver is registered. The resolver endpoint is configurable through `T3N_DID_RESOLVER_URL`, so a Terminal3-native endpoint can be adopted without a code change when one becomes available.
