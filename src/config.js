require('dotenv').config();

module.exports = {
  t3n: {
    apiUrl: process.env.T3N_API_URL || 'https://api.terminal3.io/v1',
    apiKey: process.env.T3N_API_KEY || 't3_demo_key_99481230491823',
    agentDid: process.env.T3N_AGENT_DID || 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    environment: process.env.NODE_ENV || 'development'
  },
  agentConfig: {
    name: 'T3N Enterprise Financial Audit & Compliance Agent',
    version: '1.0.0',
    mode: 'maintainable-enterprise',
    autoLogEnabled: true,
    supportedChains: ['sepolia', 'monad', 'berachain', 'base', 'sui']
  }
};
