# GraveYield Protocol

**Legal Documentation**

**Terms of Service · Privacy Policy · Risk Disclosure · Multisig Charter**

Version 4.0 — Draft for Legal Review

Last updated: October 2026

> **LEGAL REVIEW NOTICE**
>
> This document is a working legal and compliance draft prepared for the GraveYield project. It is not legal advice and has not, by itself, been reviewed or approved by qualified counsel in any particular jurisdiction.
>
> Before public mainnet launch, the GraveYield project should obtain jurisdiction-specific legal advice regarding the protocol's permissionless salvage mechanism, property-rights implications, digital-asset regulation, sanctions and AML/CFT obligations, privacy requirements, entity structure, taxation, and applicable consumer-protection requirements.
>
> References in this document to a future legal entity, governance structure, audit, regulatory position, or protocol capability do not mean that such item currently exists unless expressly stated.

---

## PART I — TERMS OF SERVICE

### Important Notice

Read these Terms, the Privacy Policy, and the Protocol Risk Disclosure before interacting with GraveYield.

GraveYield is experimental decentralized software infrastructure. Interaction with smart contracts may result in the loss of digital assets.

If you do not understand the risks or legal implications of interacting with the Protocol, do not interact with it.

---

### 1. Definitions

**"Protocol"**

The GraveYield smart-contract system and associated software infrastructure, including the GraveScanner and GraveVault programs, supporting SDKs, interfaces, documentation, and related infrastructure.

**"Interface"**

Any web-based interface operated or published by the GraveYield project for interacting with the Protocol.

**"Salvor"**

A wallet or entity that submits a valid salvage transaction and performs the required on-chain and off-chain work associated with a Salvage Operation.

**"Candidate Pool"**

A liquidity pool identified as potentially satisfying the Protocol's eligibility conditions.

**"Eligible Pool"**

A Candidate Pool that has successfully satisfied the applicable GraveScanner eligibility process and has a currently valid eligibility certification.

**"Salvage Operation"**

An authorized protocol operation intended to withdraw liquidity from an Eligible Pool, convert recovered assets where applicable, and distribute resulting proceeds according to the Protocol's applicable settlement rules.

**"LP Holder"**

A person or entity holding liquidity-provider tokens or otherwise holding an economic interest represented by such tokens.

**"Salvage Proceeds"**

The assets actually recovered and made available for settlement by a successful Salvage Operation.

**"Multisig"**

The governance or administrative signing authority designated by the Protocol for functions that remain subject to governance control.

**"Team"**

The individuals and entities contributing to the development, maintenance, research, or operation of GraveYield.

---

### 2. Nature of the Protocol

#### 2.1 Software Infrastructure

GraveYield is software infrastructure intended to coordinate a deterministic lifecycle for abandoned or potentially abandoned liquidity.

The Protocol is not represented as:

- a bank;
- broker;
- dealer;
- investment adviser;
- investment fund;
- exchange;
- custodian;
- insurer;
- lender;
- or financial institution.

No statement in these Terms should be interpreted as creating such a relationship.

The Protocol is intended to operate through smart contracts and associated software. Smart-contract behavior is ultimately determined by deployed code and blockchain state, not by descriptions contained in this document.

---

#### 2.2 No Protocol Token

As of the date of this document, GraveYield does not operate an official $GRAVE token, security token, NFT program, points program, staking program, presale, or token sale.

No person should rely on statements by third parties concerning an alleged GraveYield token, airdrop, allocation, presale, or investment opportunity unless such statement is independently confirmed through official GraveYield channels.

---

#### 2.3 Permissionless Protocol Design

Where technically enabled, the Protocol is designed to permit third parties to interact directly with the smart contracts without requiring an account maintained by GraveYield.

Permissionless access does not mean unrestricted access to the Interface or that every jurisdiction permits every form of participation.

The Interface may impose operational restrictions, including geographic, sanctions-related, technical, or security restrictions, where applicable.

Direct interaction with deployed smart contracts may not be subject to the same interface-level restrictions.

---

### 3. Deterministic Abandoned-Liquidity Lifecycle

GraveYield is designed around the following general lifecycle:

```text
Pool discovery
    ↓
Candidate identification
    ↓
Eligibility evaluation
    ↓
Confirmation period
    ↓
Eligibility certification
    ↓
Salvage transaction
    ↓
Liquidity recovery
    ↓
Asset conversion where applicable
    ↓
Settlement
    ↓
LP-holder claims
```

The purpose of this architecture is to reduce discretionary decision-making and establish explicit protocol conditions for when a pool may enter the salvage process.

The exact criteria, parameters, supported AMMs, supported lockers, oracle mechanisms, and transaction requirements may change during development and governance.

Only capabilities actually deployed and enabled by the Protocol should be treated as operational.

---

### 4. Permissionless Salvage and Legal Uncertainty

GraveYield uses the concept of "salvage" to describe the protocol mechanism through which a third party may perform work associated with recovering liquidity from a pool that satisfies predefined protocol conditions.

The project recognizes that this mechanism does not automatically establish a legal right to recover or appropriate another person's property.

The project does not represent that maritime salvage law necessarily applies to decentralized liquidity pools or that participation in GraveYield creates a legally recognized salvage claim in any jurisdiction.

The maritime-salvage concept is therefore an analytical analogy and potential legal theory, not a representation of settled law.

Applicable legal questions may include, depending on circumstances and jurisdiction:

- property and possessory rights;
- conversion;
- unjust enrichment;
- constructive trust;
- abandoned or unclaimed property;
- escheatment;
- contract law;
- securities law;
- commodities and derivatives regulation;
- money-transmission/payment regulation;
- digital-asset regulation;
- sanctions;
- AML/CFT requirements;
- tax law;
- consumer-protection law.

Users are responsible for determining whether their participation is lawful in their jurisdiction.

---

### 5. Salvor Economics

A Salvor may incur costs including:

- transaction fees;
- priority fees;
- RPC costs;
- infrastructure costs;
- routing costs;
- monitoring costs;
- computational resources;
- opportunity costs;
- and losses arising from failed or unprofitable transactions.

The Protocol's settlement mechanism is designed to allocate a portion of successful Salvage Proceeds to the Salvor.

The existence of a potential Salvor allocation does not guarantee that any Salvage Operation will be profitable.

No representation is made regarding expected returns.

---

### 6. LP-Holder Allocation

The Protocol is designed to preserve a portion of successful Salvage Proceeds for eligible LP holders.

The current economic design targets a 40% LP-holder allocation, subject to the actual deployed program configuration and implementation.

Eligibility and allocation are determined according to the Protocol's snapshot and claim mechanism.

The LP allocation should not be interpreted as a legal determination that any particular person has a legally enforceable property claim under every applicable jurisdiction.

The Protocol's on-chain allocation mechanism does not resolve disputes regarding off-chain ownership, succession, beneficial ownership, contractual rights, or competing legal claims.

---

### 7. Eligibility and Certification

A pool may be evaluated against multiple protocol criteria, including conditions relating to:

- trading inactivity;
- price deterioration;
- residual liquidity;
- LP supply;
- LP locking;
- and multi-epoch confirmation.

The precise criteria and thresholds are determined by the deployed Protocol configuration.

Eligibility certification is a protocol state transition. It is not a legal declaration that a pool or its assets have been abandoned under applicable law.

The Protocol may refuse, invalidate, expire, or prevent certification where technical or protocol conditions are not satisfied.

---

### 8. User Responsibilities

Users are responsible for:

1. controlling their own private keys;
2. verifying transactions before signing;
3. reviewing transaction parameters and destination addresses;
4. understanding applicable blockchain and smart-contract risks;
5. complying with applicable law;
6. determining whether participation is permitted in their jurisdiction;
7. ensuring that funds used in Protocol interactions are lawful;
8. avoiding attempts to manipulate eligibility, settlement, claims, or governance;
9. maintaining appropriate operational and wallet security.

---

### 9. No Investment, Legal, or Tax Advice

Nothing provided through GraveYield constitutes:

- investment advice;
- legal advice;
- tax advice;
- accounting advice;
- financial planning;
- a recommendation to acquire or dispose of digital assets.

Users should obtain independent professional advice where appropriate.

---

### 10. Experimental Software

GraveYield remains experimental until the project expressly announces otherwise.

Development-stage code may contain:

- bugs;
- incomplete functionality;
- incorrect assumptions;
- integration failures;
- economic vulnerabilities;
- oracle failures;
- dependency failures;
- or security vulnerabilities.

A successful test or audit does not guarantee that the Protocol is secure.

---

### 11. Third-Party Dependencies

The Protocol may interact with or depend upon third-party infrastructure, including decentralized exchanges, liquidity pools, RPC providers, blockchain infrastructure, routing systems, oracle systems, wallets, and other smart contracts.

GraveYield does not control those third-party systems.

Failure, manipulation, compromise, congestion, upgrade, or discontinuation of a third-party dependency may affect the Protocol.

---

### 12. Disclaimers

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE PROTOCOL, INTERFACE, SDK, DOCUMENTATION, AND RELATED SOFTWARE ARE PROVIDED "AS IS" AND "AS AVAILABLE."

NO REPRESENTATION OR WARRANTY IS MADE THAT:

- THE PROTOCOL WILL OPERATE WITHOUT INTERRUPTION;
- THE PROTOCOL WILL BE ERROR-FREE;
- ELIGIBILITY DETERMINATIONS WILL ALWAYS BE CORRECT;
- A SALVAGE OPERATION WILL BE PROFITABLE;
- A PARTICULAR POOL WILL BE ELIGIBLE;
- A PARTICULAR TRANSACTION WILL SUCCEED;
- A PARTICULAR ASSET WILL BE CONVERTIBLE;
- THE PROTOCOL WILL REMAIN AVAILABLE;
- OR ANY PARTICULAR ECONOMIC OR LEGAL RESULT WILL OCCUR.

TO THE MAXIMUM EXTENT PERMITTED BY LAW, ALL IMPLIED WARRANTIES ARE DISCLAIMED.

---

### 13. Limitation of Liability

TO THE MAXIMUM EXTENT PERMITTED BY APPLICABLE LAW, THE TEAM AND ANY FUTURE ENTITY SPECIFICALLY RESPONSIBLE FOR OPERATING THE GRAVEYIELD INTERFACE SHALL NOT BE LIABLE FOR INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL, EXEMPLARY, OR PUNITIVE DAMAGES ARISING FROM USE OF OR INABILITY TO USE THE PROTOCOL.

NOTHING IN THESE TERMS IS INTENDED TO EXCLUDE LIABILITY THAT CANNOT LAWFULLY BE EXCLUDED OR LIMITED.

Any final liability limitation, governing-law provision, arbitration provision, or waiver should be finalized by qualified counsel after the project's legal entity and operating jurisdictions have been established.

---

### 14. Governing Law

No governing law or dispute-resolution provision should be treated as finalized until the applicable GraveYield legal entity and operating structure have been established and reviewed by counsel.

The project may subsequently publish a jurisdiction-specific governing-law and dispute-resolution provision.

---

## PART II — PRIVACY POLICY

### 1. Scope

This Privacy Policy applies to personal information collected through GraveYield-operated interfaces and services.

It does not control information collected independently by:

- wallets;
- blockchain networks;
- RPC providers;
- analytics providers;
- decentralized exchanges;
- third-party websites;
- or other third-party infrastructure.

---

### 2. Blockchain Transparency

Interactions with Solana are publicly recorded.

Depending on the transaction, publicly visible information may include:

- wallet addresses;
- token balances;
- transaction signatures;
- program interactions;
- timestamps;
- amounts;
- account addresses;
- and other blockchain metadata.

Blockchain records are generally permanent and cannot be deleted by GraveYield.

Users should therefore avoid assuming that blockchain interaction is anonymous.

---

### 3. Interface Data

A GraveYield-operated Interface may receive or process information necessary to operate the service, potentially including:

- wallet public addresses;
- IP addresses;
- browser information;
- device information;
- access timestamps;
- error and security logs;
- transaction-related technical information.

The actual categories collected should correspond to the deployed Interface and its service providers.

The project should not claim that a particular category of information is collected or deleted unless the deployed infrastructure actually does so.

---

### 4. Private Keys

GraveYield does not require users to provide private keys or seed phrases.

Users should never provide private keys, seed phrases, wallet recovery phrases, or signing credentials to GraveYield personnel or websites.

---

### 5. Cookies

The Interface may use essential cookies or equivalent browser storage required for basic functionality.

Any analytics, advertising, or non-essential tracking technologies should be disclosed separately before deployment.

---

### 6. Security and Compliance Screening

If an Interface performs sanctions, compliance, fraud, abuse, or security screening, the applicable screening practices and service providers should be disclosed accurately.

On-chain smart contracts should not be described as performing screening unless that functionality is actually implemented in the deployed programs.

---

### 7. Data Retention

Retention periods depend on the actual infrastructure used by the Interface and its service providers.

The project should publish specific retention periods only after confirming them against the production infrastructure.

Blockchain records are outside the project's ability to delete or modify.

---

## PART III — PROTOCOL RISK DISCLOSURE

### Critical Warning

INTERACTION WITH GRAVEYIELD MAY RESULT IN PARTIAL OR TOTAL LOSS OF DIGITAL ASSETS.

DO NOT INTERACT WITH THE PROTOCOL UNLESS YOU UNDERSTAND THE RISKS.

---

### 1. Smart-Contract Risk

Smart contracts can contain vulnerabilities, logic errors, arithmetic errors, access-control errors, or unforeseen interactions.

An audit cannot eliminate these risks.

---

### 2. Eligibility Risk

The Protocol attempts to determine whether a liquidity pool satisfies predefined conditions.

Eligibility mechanisms can fail or produce incorrect results because of:

- incorrect data;
- stale information;
- implementation errors;
- manipulated inputs;
- unexpected AMM behavior;
- oracle failures;
- incomplete historical information;
- or conditions that cannot be observed on-chain.

A protocol designation of "eligible" does not constitute a legal determination that the pool is abandoned.

---

### 3. Oracle and Historical-Data Risk

Certain eligibility criteria depend on historical information.

The project is actively developing mechanisms to establish authoritative evidence for matters including pool activity and launch-price baselines.

Until those mechanisms are fully implemented and verified, users must treat historical eligibility information as experimental.

---

### 4. AMM Integration Risk

Different AMMs use different account layouts, authority models, liquidity mechanisms, and settlement procedures.

A successful integration with one AMM does not establish safety for another.

The initial production target is expected to be deliberately narrow.

---

### 5. Liquidity-Recovery Risk

A Salvage Operation may fail because of:

- insufficient liquidity;
- incorrect pool state;
- invalid accounts;
- changed pool state;
- slippage;
- transaction failure;
- third-party program failure;
- congestion;
- or other unexpected conditions.

---

### 6. Market and Slippage Risk

Recovered tokens may have little or no economically realizable value.

A token's displayed market price does not guarantee that the token can be sold at that price.

Jupiter or another routing system may return substantially less value than expected.

A Salvor may lose transaction costs even when a Salvage Operation fails.

---

### 7. MEV and Competition Risk

Salvage opportunities may be observable to competing participants.

Other bots or users may attempt to execute the same opportunity.

A transaction may fail even if the opportunity appeared profitable when evaluated.

Priority fees and private transaction infrastructure may affect execution.

---

### 8. LP Snapshot Risk

LP-holder allocations depend on the snapshot methodology used by the Protocol.

Potential issues include:

- token transfers;
- burns;
- locked positions;
- ownership changes;
- incorrect historical balances;
- data-indexing errors;
- lost wallets;
- disputed beneficial ownership.

A Merkle proof verifies inclusion in the Protocol's committed snapshot; it does not independently determine legal ownership.

---

### 9. Certificate Expiration Risk

Eligibility certificates may have a limited validity period.

A pool may become ineligible, change state, or become unavailable before a Salvage Operation is executed.

---

### 10. Governance and Upgrade Risk

Where governance authority remains enabled, authorized governance participants may be able to change protocol parameters, upgrade programs, pause functionality, or perform other explicitly authorized operations.

The exact scope of governance authority depends on the deployed program version.

Users should verify the currently deployed program, configuration, authority, and timelock state rather than relying solely on historical documentation.

---

### 11. Dependency Risk

Failures or exploits affecting Solana, AMMs, Jupiter, RPC providers, wallets, oracle systems, or other dependencies may affect GraveYield.

---

### 12. Regulatory and Legal Risk

The legal treatment of permissionless digital-asset recovery mechanisms is uncertain and may vary significantly between jurisdictions.

Potential legal issues include:

- property rights;
- unclaimed-property law;
- conversion;
- unjust enrichment;
- securities regulation;
- commodities regulation;
- money transmission;
- AML/CFT;
- sanctions;
- taxation;
- consumer protection;
- licensing.

Users bear responsibility for understanding the law applicable to them.

---

### 13. No Insurance

Digital assets interacting with GraveYield are not represented as being protected by bank deposit insurance, securities-investor protection, or any equivalent government insurance scheme.

No guarantee of recovery is provided.

---

### 14. No Guaranteed Profit

Neither Salvors nor LP holders are guaranteed a particular economic outcome.

Salvors may incur costs and receive nothing.

LP holders may receive less than expected or no economically meaningful value.

Recovered assets may have little or no market value.

---

## PART IV — MULTISIG CHARTER

### 1. Purpose

The Multisig exists to manage those protocol functions that remain subject to governance authority.

Its role should be limited to the powers actually implemented by the deployed programs.

---

### 2. Governance Principles

Governance should follow these principles:

1. minimize discretionary control over user assets;
2. preserve the LP-holder allocation mechanism;
3. publish material changes;
4. use timelocks where technically implemented;
5. maintain transparent on-chain governance records;
6. avoid changing economic rules retroactively;
7. disclose emergency actions;
8. separate treasury management from user-fund custody.

---

### 3. Governance Authority

Depending on the deployed version, governance may control or influence:

- protocol configuration;
- eligibility thresholds;
- supported integrations;
- protocol pause mechanisms;
- program upgrade authority;
- treasury operations;
- authorized administrative accounts.

The project must not represent a governance power as technically impossible unless the deployed program actually prevents it.

---

### 4. User Funds

The intended protocol architecture separates governance authority from LP-holder proceeds.

Governance should not be represented as having access to LP-holder proceeds unless the deployed programs actually provide such authority.

Any claimed inability to access, redirect, freeze, or sweep user funds should be verified against the deployed program before publication.

---

### 5. Economic Parameters

The initial protocol economic model targets:

```text
40% — eligible LP-holder allocation
40% — Salvor allocation
20% — Protocol allocation
```

These percentages should be described as protocol rules only to the extent that the deployed programs enforce them.

No governance action should be used to retroactively alter an already completed Salvage Operation.

---

### 6. Treasury

Protocol treasury proceeds may be used for legitimate project purposes including:

- security audits;
- bug bounty programs;
- infrastructure;
- RPC and indexing;
- development;
- legal and compliance work;
- ecosystem integrations;
- operational expenses;
- and other expenses directly supporting GraveYield.

Treasury policies should be updated when the project's legal entity and governance structure are finalized.

---

### 7. Program Upgrades

If upgrade authority exists, the project should publicly disclose material upgrades where reasonably practicable.

Any claimed upgrade timelock must correspond to an actual technical or governance control.

Emergency procedures should include:

- documented reason for emergency action;
- affected components;
- security implications;
- remediation plan;
- public post-mortem where appropriate.

---

### 8. Path Toward Reduced Governance

Following security review and operational maturity, the project may evaluate reducing or removing upgrade authority.

Immutability should not be represented as inherently safer.

It creates a tradeoff:

```text
less governance attack surface
        vs.
less ability to correct future vulnerabilities
```

Any move toward immutability should therefore be preceded by appropriate security review and public disclosure.

---

## PART V — DOCUMENT CONTROL

This document is subordinate to the actual behavior of deployed smart contracts.

Where documentation and deployed code differ, users should not assume that the documentation creates functionality that the programs do not implement.

Material changes to the Protocol should result in corresponding updates to:

- Terms of Service;
- Privacy Policy;
- Risk Disclosure;
- Multisig Charter;
- Technical Documentation;
- Whitepaper;
- and deployment/configuration documentation,

as applicable.

> Current version: 4.0 Draft
>
> Status: Pre-mainnet legal/compliance draft
>
> Last updated: October 2026
