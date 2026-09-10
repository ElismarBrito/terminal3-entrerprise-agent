import dotenv from 'dotenv';
dotenv.config();

export const config = {
  t3n: {
    apiKey: process.env.T3N_API_KEY || 't3_demo_key_99481230491823',
    environment: process.env.T3N_ENV || 'testnet',
    fallbackTrustAnchor: { unsafe_trust_server: true }
  },
  agent: {
    name: 'T3N Enterprise Financial Audit & Compliance Agent',
    version: '1.0.0',
    agentDid: process.env.T3N_AGENT_DID || 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    supportedChains: {
      sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
      base: 'https://base-sepolia-rpc.publicnode.com',
      monad: 'https://rpc-testnet.monad.xyz'
    }
  }
};
