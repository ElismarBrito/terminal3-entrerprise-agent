# Terminal 3 ADK Developer Experience, Bug Reports & DX Feedback

**Submitted by:** Elismar (Superteam Bounty Submission)  
**Target:** Terminal 3 ADK Quickstart & Developer Documentation  
**Date:** September 10, 2026  

---

## 📌 Executive Summary
During the integration and development of the **T3N Enterprise Financial Audit & Compliance Agent**, we evaluated the Terminal 3 Agent Developer Kit (ADK) quickstart workflow, documentation readability, SDK initialization paths, and onboarding UX. 

Below is an actionable list of **3 verified bugs/documentation gaps** and **2 UX enhancement recommendations** designed to improve developer conversion for Terminal 3.

---

## 🐞 Bug Reports & Technical Gaps

### 1. `[Bug]` SSO Redirect Loop on `go.terminal3.io/adk-community`
* **Severity:** Medium
* **Description:** When registering via Single Sign-On (SSO) on mobile or restricted browser viewports, the callback parameter `redirect_uri` intermittently drops session state tokens, causing a 2-step authentication loop before granting the DID keypair.
* **Steps to Reproduce:**
  1. Open `https://go.terminal3.io/adk-community` on mobile Safari or Chrome with third-party cookies disabled.
  2. Complete SSO authorization.
  3. Notice redirection back to landing without appending `?did=...` token payload.
* **Recommended Fix:** Ensure fallback session storage (`localStorage`/`sessionStorage`) persists state tokens across OAuth redirect boundaries.

### 2. `[Doc Defect]` Missing Parameter Definitions for `T3N_AGENT_DID` Schema
* **Severity:** Low-Medium
* **Description:** In `docs.terminal3.io/developers/adk/get-started/quickstart`, the environment variable schema for `T3N_AGENT_DID` does not explicitly specify the prefix requirements (e.g. `did:t3n:enterprise:` vs `did:t3n:user:`).
* **Impact:** Developers attempting to construct custom DIDs receive unhandled 400 Bad Request errors from the ADK gateway without descriptive error messages.
* **Recommended Fix:** Update section 2 of the Quickstart guide to include a regex schema definition: `^did:t3n:(enterprise|user|node):0x[a-fA-F0-9]{40}$`.

### 3. `[SDK Edge Case]` Network Timeout Handling during RPC Handshake
* **Severity:** Medium
* **Description:** When the ADK agent initializes behind public RPC endpoints under heavy congestion, the `initialize()` method lacks an explicit retry backoff policy, causing hard unhandled promise rejections.
* **Recommended Fix:** Implement an exponential backoff wrapper (3 retries with 1000ms jitter) within the core ADK client package.

---

## 💡 Developer Experience (DX) Recommendations

1. **Interactive CLI Builder (`npx create-t3-agent`):**
   Providing a 1-line interactive CLI initializer (like `create-next-app` or `create-vite`) would reduce onboarding time from 10 minutes to under 2 minutes.

2. **Built-in TypeScript Type Definitions (`@terminal3/adk`):**
   Publishing first-class TypeScript interfaces for `AgentResponse`, `DidVerificationPayload`, and `AuditRecord` will streamline enterprise integration.
