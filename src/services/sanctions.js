import { ethers } from 'ethers';
import { config } from '../config.js';

/**
 * Chainalysis OFAC Sanctions Oracle Addresses
 *
 * Source: https://etherscan.io/address/0x40C57923924B5c5c5455c48D93317139ADDaC8fb
 *
 * The Chainalysis Sanctions Oracle is a public, permissionless smart contract
 * deployed on Ethereum mainnet and major EVM chains. It reflects the current
 * OFAC SDN (Specially Designated Nationals) list and related global sanctions.
 *
 * Calling `isSanctioned(address)` is a read-only `eth_call` — zero cost,
 * no API key required, no authentication needed.
 */
const ORACLE_ADDRESSES = {
  mainnet: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
  base:    '0x3A91A31cB3dC49b4db9Ce721F50a9D076c8D739B',
  polygon: '0x40C57923924B5c5c5455c48D93317139ADDaC8fb',
};

// Minimal ABI — only the function we need
const ORACLE_ABI = ['function isSanctioned(address addr) view returns (bool)'];

const ORACLE_TIMEOUT_MS = 8000;

/**
 * Sanctions Service
 *
 * Checks wallet addresses against real on-chain OFAC sanctions data
 * via the Chainalysis Sanctions Oracle contract. No API key required.
 *
 * Also derives a KYC tier from the wallet's on-chain transaction count
 * (real data, not hardcoded).
 */
export class SanctionsService {
  constructor() {
    this._providerCache = new Map();
  }

  /**
   * Checks if a wallet address appears in the OFAC sanctions list.
   * Uses Ethereum mainnet Chainalysis Oracle.
   *
   * @param {string} walletAddress - Checksummed or lower-case ETH address
   * @returns {Promise<SanctionsCheckResult>}
   */
  async checkSanctions(walletAddress) {
    const timestamp = new Date().toISOString();

    // Validate address format first
    if (!ethers.isAddress(walletAddress)) {
      return {
        walletAddress,
        sanctionsPassed: false,
        isSanctioned: null,
        source: 'FORMAT_CHECK',
        reason: 'Invalid Ethereum address format — rejected before oracle query.',
        timestamp,
        oracleQueried: false,
      };
    }

    const checksumAddress = ethers.getAddress(walletAddress);

    try {
      const provider = this._getProvider('mainnet');
      const oracle = new ethers.Contract(ORACLE_ADDRESSES.mainnet, ORACLE_ABI, provider);

      // Race against timeout to avoid hanging on slow RPC
      const isSanctioned = await Promise.race([
        oracle.isSanctioned(checksumAddress),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`Oracle timeout after ${ORACLE_TIMEOUT_MS}ms`)), ORACLE_TIMEOUT_MS)
        ),
      ]);

      return {
        walletAddress: checksumAddress,
        sanctionsPassed: !isSanctioned,
        isSanctioned,
        source: 'CHAINALYSIS_OFAC_ORACLE',
        oracleAddress: ORACLE_ADDRESSES.mainnet,
        oracleChain: 'mainnet',
        timestamp,
        oracleQueried: true,
        note: isSanctioned
          ? '🚫 Address found in Chainalysis OFAC sanctions registry.'
          : '✅ Address not found in OFAC sanctions list (Chainalysis Oracle).',
      };

    } catch (err) {
      // Fail-safe: if oracle is unreachable, return INCONCLUSIVE — never silently pass
      console.warn(`⚠️ [Sanctions] Oracle query failed: ${err.message}`);
      return {
        walletAddress: checksumAddress,
        sanctionsPassed: null, // null = inconclusive, not a pass
        isSanctioned: null,
        source: 'CHAINALYSIS_OFAC_ORACLE',
        oracleAddress: ORACLE_ADDRESSES.mainnet,
        oracleChain: 'mainnet',
        oracleQueried: false,
        timestamp,
        error: err.message,
        note: `Oracle unreachable. Sanctions status INCONCLUSIVE — do not auto-approve.`,
      };
    }
  }

  /**
   * Derives a KYC tier from real on-chain transaction count.
   * NOT a real KYC — it's a proxy indicator based on wallet activity.
   *
   * @param {number} txCount - Transaction count from live RPC
   * @returns {{ kycLevel: string, kycBasis: string }}
   */
  deriveKycTier(txCount) {
    if (typeof txCount !== 'number' || txCount < 0) {
      return { kycLevel: 'UNVERIFIED', kycBasis: 'Invalid txCount input' };
    }
    if (txCount === 0) {
      return { kycLevel: 'UNVERIFIED', kycBasis: 'No on-chain activity detected' };
    }
    if (txCount < 10) {
      return { kycLevel: 'TIER_1_BASIC', kycBasis: `${txCount} transactions on-chain` };
    }
    if (txCount < 100) {
      return { kycLevel: 'TIER_2_STANDARD', kycBasis: `${txCount} transactions on-chain` };
    }
    return { kycLevel: 'TIER_3_ENTERPRISE', kycBasis: `${txCount} transactions on-chain` };
  }

  /** @private */
  _getProvider(network) {
    if (!this._providerCache.has(network)) {
      const rpcUrl = network === 'mainnet'
        ? config.agent.mainnetRpc
        : config.agent.supportedChains[network];
      this._providerCache.set(network, new ethers.JsonRpcProvider(rpcUrl));
    }
    return this._providerCache.get(network);
  }
}

export const sanctionsService = new SanctionsService();
