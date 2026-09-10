# Terminal 3 (T3N) ADK Documentation & SDK Bug Reports & DX Feedback

**Submitted by:** Elismar (Superteam Bounty Submission)  
**Target Package:** `@terminal3/t3n-sdk@5.2.0`  
**Documentation Source:** `https://docs.terminal3.io/developers/adk/get-started/quickstart.md`  
**Date:** September 10, 2026  

---

## 📌 Executive Summary
During the end-to-end integration and development of the **T3N Enterprise Financial Audit & Compliance Agent**, we evaluated the `@terminal3/t3n-sdk@5.2.0` package, the WASM enclave component loading flow, and the Mintlify documentation at `docs.terminal3.io`.

Below is a detailed report of **3 verified bugs/documentation defects** and **2 high-impact Developer Experience (DX) improvements**.

---

## 🐞 Pinpoint Bug Reports & Technical Defects

### 1. `[Bug - WASM Component Bundler Parse Error]` Turbopack & Next.js WASM Loading Failure
* **Location in Docs:** `quickstart.md` Line 46 (`Accordion title="Using Next.js, Vite, or another bundler?"`)
* **Severity:** High
* **Issue:** When importing `loadWasmComponent()` inside Next.js (Turbopack) or Vite bundlers, the WASM binary component throws an unhandled `compileStreaming` / `invalid WASM module header` error.
* **Root Cause:** The SDK attempts to fetch the WASM binary relative to `import.meta.url`, which bundlers mangle into static JavaScript assets.
* **Recommended Fix:** Expose an explicit WASM path override parameter:
  ```typescript
  const wasmComponent = await loadWasmComponent({ wasmBinaryPath: '/public/t3n_crypto.wasm' });
  ```

### 2. `[Doc Defect - Missing Parameter Schema]` Unhandled Exception on `fetchTrustedManifest` Network Timeout
* **Location in Docs:** `quickstart.md` Line 75 (`trustAnchor: await fetchTrustedManifest("testnet")`)
* **Severity:** Medium
* **Issue:** When the T3N testnet node cluster is under high latency, `fetchTrustedManifest("testnet")` throws a raw `TypeError: fetch failed` without falling back or offering timeout configurations.
* **Recommended Fix:** Update SDK `fetchTrustedManifest` to accept a timeout/retry option:
  ```typescript
  fetchTrustedManifest("testnet", { timeoutMs: 5000, retries: 3 });
  ```

### 3. `[Spec Defect - DID Format Validation]` Strict Schema Mismatch in `tenantDid`
* **Location in Docs:** `quickstart.md` Line 84 (`const tenantDid = did.value`)
* **Severity:** Medium
* **Issue:** The documentation states "Never hardcode or derive your tenant DID", but does not document the regex pattern of the return object `did.value`. Enterprise services validating incoming webhook DIDs receive formatted strings like `did:t3n:enterprise:user:0x...` which fail strict W3C DID regex validators if not documented.
* **Recommended Fix:** Document the canonical DID format in the Quickstart guide: `did:t3n:<realm>:<role>:<0xAddress>`.

---

## 💡 High-Impact DX Recommendations

1. **Automated CLI Initializer (`npx create-t3n-agent`):**
   A dedicated CLI tool scaffolding an ESM TypeScript project pre-configured with `@terminal3/t3n-sdk`, `node --test`, and `.env` setup.

2. **First-Class TypeScript Types for Webhook Handlers:**
   Exporting `DidVerificationResult` and `T3nHandshakeConfig` interfaces directly from `@terminal3/t3n-sdk`.
