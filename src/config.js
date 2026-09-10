import { ethers } from 'ethers';
import dotenv from 'dotenv';
dotenv.config();

/**
 * Resolves the T3N ADK API key.
 *
 * The T3N SDK's `eth_get_address(apiKey)` treats the key as an Ethereum private key.
 * When no real T3N_API_KEY is set:
 *   - In TEST/DEV: generates a random wallet so the SDK can advance to network auth.
 *   - In PRODUCTION: throws immediately — a real key is mandatory.
 *
 * To obtain a real API key: https://go.terminal3.io/adk-community
 */
function resolveAdkKey() {
  const envKey = process.env.T3N_API_KEY;

  if (!envKey && process.env.NODE_ENV === 'production') {
    throw new Error(
      '[Config] T3N_API_KEY is required in production. ' +
      'Set it via: export T3N_API_KEY="<your-key-from-terminal3.io>"\n' +
      'NEVER commit your API key to Git or include it in documentation.'
    );
  }

  if (envKey && envKey.startsWith('0x') && envKey.length === 66) {
    return envKey; // Valid 32-byte ETH private key
  }

  // Dev/test mode: generate a random wallet for SDK handshake testing
  const testWallet = ethers.Wallet.createRandom();
  if (!envKey) {
    console.warn(
      `[Config] No T3N_API_KEY set — using generated dev wallet: ${testWallet.address}\n` +
      `[Config] Set T3N_API_KEY=<real-key> for production use.`
    );
  }
  return testWallet.privateKey;
}

export const config = {
  t3n: {
    apiKey: resolveAdkKey(),
    environment: process.env.T3N_ENV || 'testnet',
    // Unsafe trust fallback is development-only and must be explicitly disabled
    // in production, even when a real API key is present.
    allowUnsafeTrustFallback: process.env.NODE_ENV !== 'production' && process.env.T3N_ALLOW_UNSAFE_TRUST_FALLBACK !== 'false',
    /**
     * KNOWN LIMITATION (Bug #2 in BUG_REPORTS_AND_FEEDBACK.md):
     * fetchTrustedManifest() returns a malformed manifest from the T3N testnet cluster.
     * This fallback is ONLY used when the manifest fetch fails.
     * When fallback is active, trustVerified = false and APPROVE decisions are blocked.
     * Remove this fallback and replace with a hard failure once Bug #2 is resolved upstream.
     */
    fallbackTrustAnchor: { unsafe_trust_server: true },
  },
  agent: {
    name: 'T3N Enterprise Financial Audit & Compliance Agent',
    version: '1.2.0',
    agentDid: process.env.T3N_AGENT_DID || 'did:t3n:enterprise:audit:0x909F5A24F4f3353A823Bed637410D21E6521BAEC',
    supportedChains: {
      sepolia: 'https://ethereum-sepolia-rpc.publicnode.com',
      base: 'https://base-sepolia-rpc.publicnode.com',
      monad: 'https://rpc-testnet.monad.xyz',
    },
    // The DIF Universal Resolver is the default. A T3N-native resolver can be
    // supplied without changing code when Terminal3 exposes a public endpoint.
    didResolverUrl: process.env.T3N_DID_RESOLVER_URL || 'https://dev.uniresolver.io/1.0/identifiers/',
    mainnetRpc: 'https://ethereum-rpc.publicnode.com',
  },
};
