import './shared-cometa.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider, TransactionBuilder, TxIn, UTxO, Wallet } from '@biglup/cometa';
import {
  type AccountRecord,
  type AccountState,
  type DiscoveredAccount,
  type Grant,
  LOVELACE,
  accountByOwner,
  createAccount,
  findAccountUtxos,
  issueGrant,
  paymentKeyHashOf,
  posixTimeToSlot,
  revokeGrant,
  spendWithDevice,
  spendWithGrant,
} from 'cardano-account-custody-offchain';
import { config as loadEnvFile } from 'dotenv';
import { type CollateralBody, type LeaseBody, SponsorError, SponsorWallet, type SponsorWalletOptions } from '../src/index.js';
import { presetCollateralBound } from '../src/client/sponsor-wallet.js';
import { Cometa } from '../src/cometa.js';
import { type Config, loadConfig } from '../src/config.js';
import type { RecordedAuditEntry } from '../src/audit.js';
import type { PoolCounts } from '../src/http/health.js';
import { createLogger } from '../src/logger.js';
import { type ParsedTransaction, parseTransaction } from '../src/policy/parse.js';
import { createService } from '../src/service.js';
import { type SlotSettings, slotAt } from '../src/slots.js';

/** The repository root, where the environment file and the evidence document live. */
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENV_PATH = resolve(REPO_ROOT, '.env');
const EVIDENCE_PATH = resolve(REPO_ROOT, 'docs', 'preprod-evidence.md');

/** The Blockfrost preprod endpoint, queried directly for what the provider does not expose: reward account status. */
const BLOCKFROST_URL = 'https://cardano-preprod.blockfrost.io/api/v0';

/** Where a preprod transaction can be looked at. */
const EXPLORER_URL = 'https://preprod.cardanoscan.io/transaction';

/** How long to wait for a transaction to be confirmed and for the provider's view to catch up. */
const CONFIRMATION_TIMEOUT_MS = 10 * 60 * 1000;
const VIEW_TIMEOUT_MS = 5 * 60 * 1000;
const VIEW_POLL_MS = 5_000;

/** The first account index of the sponsor mnemonic tried for a fresh wallet, and how many are tried. */
const FIRST_FRESH_ACCOUNT = 10;
const FRESH_ACCOUNT_CANDIDATES = 50;

/** The pool the run wants to find, and what it asks for when the pool is short: the shared collateral UTxO and a spare for it. */
const MINIMUM_FREE_FEE_UTXOS = 3;
const REPLENISH_FEE_UTXOS = 5;
const REPLENISH_COLLATERAL_UTXOS = 2;

/** The lovelace in one tADA. */
const TADA = 1_000_000n;

/** What the account receives and pays away in the run. */
const DEPOSIT_LOVELACE = 50n * TADA;
const OWNER_SPEND_LOVELACE = 5n * TADA;
const AGENT_SPEND_LOVELACE = 3n * TADA;
const OVER_CAP_SPEND_LOVELACE = 8n * TADA;

/** The grant issued to the agent: one slot, a per call cap and a total cap of the same small amount, the recipient address only. */
const GRANT_SLOT = 0n;
const GRANT_CAP = 10n * TADA;
const GRANT_LIFETIME_MS = 2n * 60n * 60n * 1000n;

/** How many slots an agent spend stays valid for: within the service's collateral validity window, which it must not outlast. */
const AGENT_VALIDITY_SLOTS = 300n;

/** Where the validity upper bound of a device operation comes from: the adapter's builder presets it within the collateral validity window. */
const ADAPTER_BOUND = 'within the collateral validity window, as the adapter presets it';

/** Where the validity upper bound of an agent spend comes from: the grant builder sets it to its `validUntilSlot`, over the adapter's preset. */
const BUILDER_BOUND = `set by the builder's validUntilSlot, ${AGENT_VALIDITY_SLOTS} slots ahead`;

/** The sponsor lovelace the refused creation tries to pay a third party. */
const LEAK_LOVELACE = 5n * TADA;

/** The most characters of a refusal detail the evidence quotes, since a provider's evaluation failure can run long. */
const MAX_REFUSAL_DETAIL = 1_500;

/** How many collateral UTxOs the pool holds live: the shared one when there is one, and the spares. */
const collateralCount = (counts: PoolCounts): number => counts.collateral.spare + (counts.collateral.shared ? 1 : 0);

/** The collateral of the pool as the evidence states it. */
const collateralSummary = (counts: PoolCounts): string =>
  `${counts.collateral.shared ? 'one shared collateral UTxO' : 'no shared collateral UTxO'} and ${counts.collateral.spare} spare`;

/** The password cometa encrypts the derived keys with, fresh for every process. */
const password = randomBytes(32);

/** Hands cometa a copy of the password, since it wipes what it is given after use. */
const getPassword = (): Promise<Uint8Array> => Promise.resolve(new Uint8Array(password));

/** Sleeps for a number of milliseconds. */
const sleep = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

/** A lovelace amount with its tADA reading. */
const ada = (lovelace: bigint | number): string => `${lovelace} lovelace (${(Number(lovelace) / 1_000_000).toFixed(6)} tADA)`;

/** The explorer link of a transaction. */
const link = (txId: string): string => `[${txId}](${EXPLORER_URL}/${txId})`;

/** A UTxO reference as the document prints it. */
const ref = (utxo: UTxO | { txHash: string; index: number }): string =>
  'input' in utxo ? `${utxo.input.txId}#${utxo.input.index}` : `${utxo.txHash}#${utxo.index}`;

/** The reference of a transaction input. */
const inputRef = (input: TxIn): string => `${input.txId}#${input.index}`;

/** The slot the current wall clock time falls in on preprod. */
const currentSlot = (): bigint => posixTimeToSlot(BigInt(Date.now()));

/** A single address wallet of one account of the sponsor mnemonic. */
const walletOf = (provider: Provider, mnemonics: string[], account: number): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics,
    provider,
    getPassword,
    credentialsConfig: { account, paymentIndex: 0, stakingIndex: 0 },
  });

/** Blockfrost's answer to a query, or undefined when the resource does not exist. */
const blockfrost = async <T>(projectId: string, path: string): Promise<T | undefined> => {
  const response = await fetch(`${BLOCKFROST_URL}${path}`, { headers: { project_id: projectId } });
  if (response.status === 404) {
    return undefined;
  }
  if (!response.ok) {
    throw new Error(`Blockfrost answered ${path} with status ${response.status}`);
  }
  return (await response.json()) as T;
};

/**
 * Whether Blockfrost lists a reward account as registered. A never
 * registered account is not listed at all, and one registered in the
 * current epoch is listed as registered but not yet active, since
 * activity follows the epoch boundary.
 */
const isStakeCredentialRegistered = async (projectId: string, rewardAddress: string): Promise<boolean> => {
  const account = await blockfrost<{ registered: boolean }>(projectId, `/accounts/${rewardAddress}`);
  return account?.registered === true;
};

/** Polls until `check` holds, or fails with `what` once the view timeout has passed. */
const waitUntil = async (what: string, check: () => Promise<boolean>): Promise<void> => {
  const deadline = Date.now() + VIEW_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await check()) {
      return;
    }
    await sleep(VIEW_POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}`);
};

/**
 * Waits for a submitted transaction to be confirmed, then for the
 * provider to list an output of it at every address it pays and none of
 * the inputs it spent at those addresses, so that the next builder reads
 * the account as the transaction left it.
 */
const settle = async (provider: Provider, txId: string, tx: ParsedTransaction): Promise<void> => {
  if (!(await provider.confirmTransaction(txId, CONFIRMATION_TIMEOUT_MS))) {
    throw new Error(`Transaction ${txId} was not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000} seconds`);
  }
  const spent = new Set(tx.inputs.map(inputRef));
  for (const address of new Set(tx.outputs.map((output) => output.address))) {
    await waitUntil(`the provider's view of ${address} after ${txId}`, async () => {
      const utxos = await provider.getUnspentOutputs(address);
      return utxos.some((utxo) => utxo.input.txId === txId) && utxos.every((utxo) => !spent.has(ref(utxo)));
    });
  }
};

/** What a call to the service answered. */
interface Answer<T> {
  status: number;
  body: T;
}

/** Calls the running service with a bearer key, sending `body` as JSON when given. */
const call = async <T>(baseUrl: string, key: string, method: 'GET' | 'POST', path: string, body?: unknown): Promise<Answer<T>> => {
  const headers: Record<string, string> = { authorization: `Bearer ${key}` };
  if (body !== undefined) {
    headers['content-type'] = 'application/json';
  }
  const response = await fetch(`${baseUrl}${path}`, body === undefined ? { method, headers } : { method, headers, body: JSON.stringify(body) });
  return { status: response.status, body: (await response.json()) as T };
};

/** The service running in this process, reachable at a local port. */
interface RunningService {
  baseUrl: string;
  sponsorAddress: string;
  /** The sponsor UTxOs outside the pool as of the last sync, which a deposit may spend without touching what the service hands out. */
  reserveUtxos(): UTxO[];
  stop(): Promise<void>;
}

/** Assembles and starts the service against preprod on a free local port, logging warnings only. */
const startService = async (config: Config, provider: Provider): Promise<RunningService> => {
  const logger = createLogger();
  logger.level = 'warn';
  const service = await createService({ config, provider, logger });
  await service.start();
  const server = await new Promise<Server>((listening) => {
    const started = service.app.listen(0, '127.0.0.1', () => listening(started));
  });
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    sponsorAddress: service.serviceWallet.address,
    reserveUtxos: () => service.sync.reserve().utxos,
    stop: () =>
      new Promise((closed, failed) => {
        server.close((err) => {
          service.stop();
          if (err) {
            failed(err);
          } else {
            closed();
          }
        });
      }),
  };
};

/** The pool as the admin route reports it. */
interface PoolBody {
  pool: PoolCounts;
  reserve: { utxos: number; lovelace: string };
}

/** What a replenish answered. */
interface ReplenishBody {
  txId: string | null;
  feeOutputs: number;
  collateralOutputs: number;
  reserveLovelace: string;
}

/** A wallet of the run at an account index of the sponsor mnemonic, holding nothing, with the account its key would own. */
interface FreshWallet {
  index: number;
  wallet: Wallet;
  address: string;
  keyHash: string;
  account: DiscoveredAccount;
}

/**
 * The first `count` wallets, from the candidate account indexes of the
 * mnemonic, whose stake credential is not registered. A credential stays
 * registered for as long as its account exists, and an account is never
 * deleted, so a key that already created an account can never create
 * another, and every run takes fresh ones. The wallets must hold nothing,
 * which the provider confirms for each one taken: the sponsor pays for
 * the creation and the account pays for the rest, so a wallet holding
 * ADA would leave the proof open to paying from it.
 */
const freshWallets = async (provider: Provider, config: Config, mnemonics: string[], count: number): Promise<FreshWallet[]> => {
  const wallets: FreshWallet[] = [];
  for (let index = FIRST_FRESH_ACCOUNT; index < FIRST_FRESH_ACCOUNT + FRESH_ACCOUNT_CANDIDATES && wallets.length < count; index += 1) {
    const wallet = await walletOf(provider, mnemonics, index);
    const address = (await wallet.getChangeAddress()).toString();
    const keyHash = paymentKeyHashOf(address);
    if (keyHash === undefined) {
      throw new Error('The wallet did not derive a key address');
    }
    const account = accountByOwner(keyHash);
    if (!account.stateNftAssetId.startsWith(config.accountScriptHash)) {
      throw new Error(`The linked contract library derives account script ${account.stateNftAssetId.slice(0, 56)} but the service is configured for ${config.accountScriptHash}`);
    }
    if (!(await isStakeCredentialRegistered(config.blockfrostProjectId, account.rewardAddress))) {
      const held = await provider.getUnspentOutputs(address);
      if (held.length > 0) {
        throw new Error(`Account index ${index} holds ${held.length} UTxOs at ${address}; a fresh wallet must hold nothing`);
      }
      wallets.push({ index, wallet, address, keyHash, account });
    }
  }
  if (wallets.length < count) {
    throw new Error(`Fewer than ${count} account indexes from ${FIRST_FRESH_ACCOUNT} onwards have an unregistered stake credential`);
  }
  return wallets;
};

/** The initial state of an account owned by one key: that device alone, no grants, generation zero. */
const initialState = (owner: string): AccountState => ({ devices: [owner], grants: [], grantGeneration: 0n });

/**
 * A sponsor wallet whose builders pay a third party out of the sponsor's
 * funds before the contract's builder adds the creation, as a client bent
 * on drawing more than the creation costs would build; the service must
 * refuse it under the sponsor outflow rule.
 */
class LeakingSponsorWallet extends SponsorWallet {
  constructor(
    options: SponsorWalletOptions,
    private readonly recipient: string,
    private readonly lovelace: bigint,
  ) {
    super(options);
  }

  override async createTransactionBuilder(): Promise<TransactionBuilder> {
    return (await super.createTransactionBuilder()).sendLovelace({ address: this.recipient, amount: this.lovelace });
  }
}

/** A refusal by the live service, as the evidence records it. */
interface Refusal {
  description: string;
  status: number;
  body: Record<string, unknown>;
}

/** The parsed transaction, or the reason it does not parse. */
const parsed = (tx: string): ParsedTransaction => {
  const result = parseTransaction(tx);
  if (result.violation !== undefined) {
    throw new Error(`The built transaction does not parse: ${result.violation.detail}`);
  }
  return result.transaction;
};

/** A refusal body with its detail cut to what the evidence quotes, when it runs longer. */
const refusalBody = (error: SponsorError): Record<string, unknown> => {
  const detail = error.detail.length > MAX_REFUSAL_DETAIL ? `${error.detail.slice(0, MAX_REFUSAL_DETAIL)}... [cut after ${MAX_REFUSAL_DETAIL} characters]` : error.detail;
  return error.rule === undefined ? { error: error.code, detail } : { error: error.code, rule: error.rule, detail };
};

/** Signs a built transaction with every wallet that must witness it, in order, and submits it through the provider. */
const submit = async (provider: Provider, signers: Wallet[], tx: string): Promise<string> => {
  const witnesses = [];
  for (const wallet of signers) {
    witnesses.push(...(await wallet.signTransaction(tx, true)));
  }
  return provider.submitTransaction(Cometa.applyVkeyWitnessSet(tx, witnesses));
};

/** What the sponsored creation cost and who paid, read off the transaction and the lease it was built on. */
interface CreationAmounts {
  fee: bigint;
  deposit: bigint;
  controlLovelace: bigint;
  change: bigint;
  sponsored: bigint;
  invalidHereafter: bigint;
}

/**
 * Reads the creation amounts off the transaction and checks that the
 * sponsor paid exactly the fee, the deposit and the control output, and
 * that the validity upper bound is the slot of the lease expiry, which
 * is what the adapter presets in fee mode.
 */
const creationAmounts = (tx: ParsedTransaction, lease: LeaseBody, owner: FreshWallet, slots: SlotSettings): CreationAmounts => {
  const registration = tx.certificates.find((certificate) => certificate.kind === 'registration');
  const control = tx.outputs.find((output) => output.address === owner.account.address && output.assets[owner.account.stateNftAssetId] === 1n);
  if (registration?.deposit === undefined || control === undefined || tx.invalidHereafter === undefined) {
    throw new Error('The creation lacks a registration with a deposit, a control output or a validity upper bound');
  }
  const change = tx.outputs.filter((output) => output.address === lease.sponsorAddress).reduce((total, output) => total + output.lovelace, 0n);
  const sponsored = BigInt(lease.fee.lovelace) - change;
  const expected = tx.fee + registration.deposit + control.lovelace;
  if (sponsored !== expected) {
    throw new Error(`The sponsor paid ${sponsored} lovelace where the fee, the deposit and the control output account for ${expected}`);
  }
  const expiry = slotAt(slots, new Date(lease.expiresAt));
  if (tx.invalidHereafter !== expiry) {
    throw new Error(`The creation stops being valid at slot ${tx.invalidHereafter} where the lease expiry is slot ${expiry}`);
  }
  return { fee: tx.fee, deposit: registration.deposit, controlLovelace: control.lovelace, change, sponsored, invalidHereafter: tx.invalidHereafter };
};

/**
 * What an operation paid from the account cost and who paid, read off
 * the transaction: the fee and the outputs away from the account come
 * out of the account's inputs, the change returns to the account, and
 * the sponsor's only part is the shared collateral, declared and
 * returned in full.
 */
interface OperationAmounts {
  fee: bigint;
  paidAway: bigint;
  accountChange: bigint;
  controlLovelace: bigint;
  collateral: CollateralBody;
  totalCollateral: bigint;
  collateralReturned: bigint;
  invalidHereafter: bigint;
}

/**
 * Reads the amounts of an operation paid from the account and checks
 * what the policy in collateral mode requires of it: every input is one
 * of the account's UTxOs, no output pays the sponsor, the collateral is
 * exactly the shared UTxO with its return to the sponsor address, and the
 * body carries the validity upper bound `expectedBound` says it should.
 */
const operationAmounts = (
  tx: ParsedTransaction,
  account: DiscoveredAccount,
  accountUtxos: Set<string>,
  collateral: CollateralBody,
  expectedBound: bigint,
): OperationAmounts => {
  const foreign = tx.inputs.map(inputRef).filter((input) => !accountUtxos.has(input));
  if (foreign.length > 0) {
    throw new Error(`The operation spends ${foreign.join(', ')}, which the account does not hold`);
  }
  if (tx.outputs.some((output) => output.address === collateral.sponsorAddress)) {
    throw new Error('The operation pays an output to the sponsor');
  }
  if (tx.collateralInputs.length !== 1 || inputRef(tx.collateralInputs[0] as TxIn) !== ref(collateral)) {
    throw new Error(`The operation declares collateral other than the shared UTxO ${ref(collateral)}`);
  }
  if (tx.collateralReturn?.address !== collateral.sponsorAddress || tx.totalCollateral === undefined || tx.invalidHereafter === undefined) {
    throw new Error('The operation lacks a collateral return to the sponsor, a total collateral or a validity upper bound');
  }
  if (tx.invalidHereafter !== expectedBound) {
    throw new Error(`The operation stops being valid at slot ${tx.invalidHereafter} where slot ${expectedBound} was expected`);
  }
  const control = tx.outputs.find((output) => output.address === account.address && output.assets[account.stateNftAssetId] === 1n);
  if (control === undefined) {
    throw new Error('The operation does not recreate the control UTxO');
  }
  const atAccount = tx.outputs.filter((output) => output.address === account.address && output !== control);
  const away = tx.outputs.filter((output) => output.address !== account.address);
  return {
    fee: tx.fee,
    paidAway: away.reduce((total, output) => total + output.lovelace, 0n),
    accountChange: atAccount.reduce((total, output) => total + output.lovelace, 0n),
    controlLovelace: control.lovelace,
    collateral,
    totalCollateral: tx.totalCollateral,
    collateralReturned: tx.collateralReturn.lovelace,
    invalidHereafter: tx.invalidHereafter,
  };
};

/** An operation paid from the account, confirmed on chain, with the state the account was left in. */
interface Operation {
  txId: string;
  amounts: OperationAmounts;
  state: AccountState;
}

/** Everything the evidence document reports. */
interface Evidence {
  ranAt: string;
  sponsorAddress: string;
  accountScriptHash: string;
  poolBefore: PoolCounts;
  replenish: ReplenishBody | undefined;
  poolAfter: PoolCounts;
  owner: FreshWallet;
  agent: FreshWallet;
  recipient: FreshWallet;
  lease: LeaseBody;
  creationTxId: string;
  creation: CreationAmounts;
  controlUtxo: UTxO;
  changeUtxo: UTxO;
  creationAudit: RecordedAuditEntry | undefined;
  depositTxId: string;
  depositFee: bigint;
  ownerSpend: Operation;
  grant: Grant;
  grantIssued: Operation;
  agentSpend: Operation;
  overCapTxHash: string;
  overCapRefusal: Refusal;
  revoked: Operation;
  leakingTxHash: string;
  creationRefusals: Refusal[];
  collateralAudit: RecordedAuditEntry[];
}

/** The lines of a refusal as the document quotes it: its description, the status and the body as JSON. */
const refusalLines = (refusal: Refusal, index: number): string[] => [
  `${index + 1}. ${refusal.description}: HTTP ${refusal.status}`,
  '',
  '   ```json',
  ...JSON.stringify(refusal.body, null, 2)
    .split('\n')
    .map((line) => `   ${line}`),
  '   ```',
  '',
];

/** The lines the document gives every operation paid from the account: its link, its bound and where it came from, its amounts and the sponsor's part. */
const operationLines = (operation: Operation, signer: string, bound: string): string[] => {
  const { amounts } = operation;
  return [
    `- Transaction: ${link(operation.txId)}, signed by ${signer} and the service`,
    `- Validity upper bound: slot ${amounts.invalidHereafter}, ${bound}`,
    `- Collateral: the shared UTxO \`${ref(amounts.collateral)}\` of ${ada(amounts.collateral.lovelace)}, total collateral ${ada(amounts.totalCollateral)},`,
    `  collateral return of ${ada(amounts.collateralReturned)} to the sponsor; nothing of it was taken, since the transaction passed phase two`,
    '',
    '| Amount | Lovelace | Paid by |',
    '| ------ | -------- | ------- |',
    `| Fee | ${ada(amounts.fee)} | the account |`,
    `| Paid away from the account | ${ada(amounts.paidAway)} | the account |`,
    `| Control UTxO | ${ada(amounts.controlLovelace)} | the account, including any growth |`,
    `| Change back to the account | ${ada(amounts.accountChange)} | |`,
    `| Sponsor lovelace spent | 0 lovelace (0.000000 tADA) | the sponsor contributed collateral only |`,
    '',
  ];
};

/** The evidence document. */
const evidenceDocument = (evidence: Evidence): string => {
  const { owner, agent, recipient, lease, creation, grant } = evidence;
  const remainingCap = evidence.agentSpend.state.grants.find((candidate) => candidate.slot === GRANT_SLOT)?.scope.cap;
  const lines = [
    '# Preprod evidence',
    '',
    `A custody account taken through its life on preprod on ${evidence.ranAt} with the fee sponsor service as the only source of`,
    'sponsor funds and collateral. The service ran against preprod with its funding wallet, a client key was issued through',
    "the admin route, and every transaction was built through the contract's own builders with the sponsor wallet adapter:",
    'in fee mode as the `sponsor` of the creation, where the service paid the fee, the registration deposit and the control',
    'UTxO for an owner wallet that holds no ADA, and in collateral mode as the `collateral` wallet of every later operation,',
    'where the account paid its own fee and the service contributed the shared collateral and nothing else. The owner and the',
    'agent wallets held no ADA at any point.',
    '',
    '## Setup',
    '',
    `- Sponsor address: \`${evidence.sponsorAddress}\``,
    `- Account script hash: \`${evidence.accountScriptHash}\``,
    `- Pool before the run: ${evidence.poolBefore.fee.free} free fee UTxOs, ${collateralSummary(evidence.poolBefore)}`,
    evidence.replenish?.txId
      ? `- Replenished with ${evidence.replenish.feeOutputs} fee and ${evidence.replenish.collateralOutputs} collateral UTxOs: ${link(evidence.replenish.txId)}`
      : '- No replenishment was needed',
    `- Pool after the run: ${evidence.poolAfter.fee.free} free fee UTxOs, ${collateralSummary(evidence.poolAfter)}`,
    `- Owner wallet: account index ${owner.index} of the sponsor mnemonic, address \`${owner.address}\`, holding no ADA`,
    `- Owner key hash: \`${owner.keyHash}\``,
    `- Agent wallet: account index ${agent.index} of the sponsor mnemonic, address \`${agent.address}\`, holding no ADA`,
    `- Agent key hash: \`${agent.keyHash}\``,
    `- Recipient address: account index ${recipient.index} of the sponsor mnemonic, \`${recipient.address}\`, the third party the account pays`,
    `- Account address: \`${owner.account.address}\``,
    `- Stake credential: \`${owner.account.stakeScriptHash}\`, reward address \`${owner.account.rewardAddress}\``,
    `- State NFT: \`${owner.account.stateNftAssetId}\``,
    '',
    '## 1. Sponsored account creation, fee mode',
    '',
    `- Lease \`${lease.leaseId}\`, expiring ${lease.expiresAt}: fee UTxO \`${lease.fee.txHash}#${lease.fee.index}\` of ${ada(lease.fee.lovelace)},`,
    `  shared collateral UTxO \`${lease.collateral.txHash}#${lease.collateral.index}\` of ${ada(lease.collateral.lovelace)}`,
    `- Validity upper bound: slot ${creation.invalidHereafter}, the lease expiry, as the adapter presets it`,
    `- Transaction: ${link(evidence.creationTxId)}, signed by the owner device and the service`,
    '',
    '| Amount | Lovelace | Paid by |',
    '| ------ | -------- | ------- |',
    `| Fee | ${ada(creation.fee)} | the sponsor |`,
    `| Stake registration deposit | ${ada(creation.deposit)} | the sponsor |`,
    `| Control UTxO | ${ada(creation.controlLovelace)} | the sponsor |`,
    `| Sponsor change | ${ada(creation.change)} | |`,
    `| Sponsored in total | ${ada(creation.sponsored)} | the sponsor |`,
    '',
    `The fee UTxO held ${ada(lease.fee.lovelace)}; the change back to the sponsor leaves exactly the fee, the deposit and the`,
    'control UTxO sponsored, which is what the sponsor outflow rule requires of a creation.',
    '',
    'On chain after confirmation:',
    '',
    `- The control UTxO \`${ref(evidence.controlUtxo)}\` sits at the account address holding ${ada(evidence.controlUtxo.output.value.coins)} and the state NFT`,
    '- The stake credential is registered: Blockfrost lists the reward address as registered, active from the next epoch',
    `- The sponsor change UTxO \`${ref(evidence.changeUtxo)}\` holds ${ada(evidence.changeUtxo.output.value.coins)}`,
    evidence.creationAudit
      ? `- The audit trail records the witness as issued: \`${JSON.stringify(evidence.creationAudit.detail)}\``
      : '- The audit trail entry for the witness was not found',
    '',
    '## 2. Deposit',
    '',
    `- Transaction: ${link(evidence.depositTxId)}, a plain transfer of ${ada(DEPOSIT_LOVELACE)} to the account address`,
    `- Paid by the funding wallet, which is the sponsor wallet spending from its reserve outside the service, with a fee of ${ada(evidence.depositFee)};`,
    '  the service was not involved and no pool UTxO was touched',
    '',
    '## 3. Owner spend, collateral mode',
    '',
    `${ada(OWNER_SPEND_LOVELACE)} paid from the account to the recipient address through \`spendWithDevice\`, with the adapter in collateral mode as`,
    "the builder's `collateral` wallet.",
    '',
    ...operationLines(evidence.ownerSpend, 'the owner device', ADAPTER_BOUND),
    '## 4. Grant issued, collateral mode',
    '',
    `A lovelace grant in slot ${grant.slot} to the agent key through \`issueGrant\`: ${ada(grant.scope.perCallCap)} per call, ${ada(grant.scope.cap)} in total,`,
    `expiring at ${new Date(Number(grant.scope.expiresAt)).toISOString()}, the recipient address as the only recipient. The larger state raises the`,
    "control UTxO's lovelace, which the account pays, as it pays the fee.",
    '',
    ...operationLines(evidence.grantIssued, 'the owner device', ADAPTER_BOUND),
    '## 5. Agent spend within the cap, collateral mode',
    '',
    `${ada(AGENT_SPEND_LOVELACE)} paid from the account to the recipient address through \`spendWithGrant\`, built from the persisted account`,
    "record with the agent wallet signing and the adapter in collateral mode as the builder's `collateral` wallet. The fee comes",
    'out of the account and counts against the grant alongside the payout.',
    '',
    ...operationLines(evidence.agentSpend, 'the agent key', BUILDER_BOUND),
    `- Remaining cap after the spend: ${remainingCap === undefined ? 'unknown' : ada(remainingCap)}`,
    '',
    '## 6. Agent spend over the cap, refused',
    '',
    `${ada(OVER_CAP_SPEND_LOVELACE)} to the recipient address through \`spendWithGrant\` built without the builder's checks, so that the validator is`,
    'the one to refuse it. The service evaluated the transaction through the provider before signing, the evaluation failed in',
    `phase two, and the service refused it under \`evaluates\` without signing. Its hash is \`${evidence.overCapTxHash}\`; it was never submitted.`,
    '',
    ...refusalLines(evidence.overCapRefusal, 0),
    '## 7. Grant revoked, collateral mode',
    '',
    `The grant in slot ${grant.slot} revoked through \`revokeGrant\`, leaving the account with ${evidence.revoked.state.grants.length} grants.`,
    '',
    ...operationLines(evidence.revoked, 'the owner device', ADAPTER_BOUND),
    '## 8. Refused creations, fee mode',
    '',
    `A second creation, for the owner at account index ${recipient.index} (\`${recipient.address}\`), built with a sponsor wallet`,
    `that slips a ${ada(LEAK_LOVELACE)} payment to the first owner's address into every builder, so that the creation`,
    'also pays sponsor value to a third party. Its hash is',
    `\`${evidence.leakingTxHash}\`; it was never submitted.`,
    '',
    ...evidence.creationRefusals.flatMap(refusalLines),
    '## Who paid what',
    '',
    '| Step | Transaction | Fee | Fee paid by | Sponsor lovelace spent | Sponsor part |',
    '| ---- | ----------- | --- | ----------- | ---------------------- | ------------ |',
    `| 1 | ${link(evidence.creationTxId)} | ${ada(creation.fee)} | the sponsor | ${ada(creation.sponsored)} | fee, deposit, control UTxO and collateral |`,
    `| 2 | ${link(evidence.depositTxId)} | ${ada(evidence.depositFee)} | the funding wallet | none through the service | none |`,
    `| 3 | ${link(evidence.ownerSpend.txId)} | ${ada(evidence.ownerSpend.amounts.fee)} | the account | 0 | collateral only |`,
    `| 4 | ${link(evidence.grantIssued.txId)} | ${ada(evidence.grantIssued.amounts.fee)} | the account | 0 | collateral only |`,
    `| 5 | ${link(evidence.agentSpend.txId)} | ${ada(evidence.agentSpend.amounts.fee)} | the account | 0 | collateral only |`,
    '| 6 | none, refused | | | 0 | none |',
    `| 7 | ${link(evidence.revoked.txId)} | ${ada(evidence.revoked.amounts.fee)} | the account | 0 | collateral only |`,
    '| 8 | none, refused | | | 0 | none |',
    '',
    '## Audit trail of the collateral mode witnesses',
    '',
    ...(evidence.collateralAudit.length === 0
      ? ['No collateral mode witness entry was found.']
      : evidence.collateralAudit.map((entry) => `- \`${JSON.stringify(entry.detail)}\``)),
    '',
  ];
  return `${lines.join('\n')}\n`;
};

/** Runs the proof against preprod and writes the evidence document. */
const main = async (): Promise<void> => {
  loadEnvFile({ path: ENV_PATH, quiet: true });
  const config = loadConfig();
  delete process.env.SPONSOR_MNEMONIC;
  delete process.env.BLOCKFROST_PREPROD_PROJECT_ID;
  delete process.env.ADMIN_API_KEY;
  await Cometa.ready();
  const provider = new Cometa.BlockfrostProvider({ network: Cometa.NetworkMagic.Preprod, projectId: config.blockfrostProjectId });

  const funding = await walletOf(provider, config.sponsorMnemonic, 0);
  const [owner, agent, recipient] = await freshWallets(provider, config, config.sponsorMnemonic, 3);
  if (owner === undefined || agent === undefined || recipient === undefined) {
    throw new Error('Three fresh wallets are needed');
  }
  const record: AccountRecord = { owner: owner.account.owner, stakeScriptHash: owner.account.stakeScriptHash, address: owner.account.address };
  console.log(`Owner wallet: account index ${owner.index} of the mnemonic, ${owner.address}`);
  console.log(`Agent wallet: account index ${agent.index} of the mnemonic, ${agent.address}`);
  console.log(`Recipient: account index ${recipient.index} of the mnemonic, ${recipient.address}`);
  console.log(`Account address: ${owner.account.address}`);

  const running = await startService(config, provider);
  console.log(`Service listening at ${running.baseUrl}, sponsor address ${running.sponsorAddress}`);
  const attempted: { hash: string; role: string }[] = [];
  try {
    const issued = await call<{ apiKey: string }>(running.baseUrl, config.adminApiKey, 'POST', '/admin/keys', { label: 'preprod proof' });
    if (issued.status !== 201) {
      throw new Error(`Issuing a client key answered ${issued.status}`);
    }
    const apiKey = issued.body.apiKey;

    const before = await call<PoolBody>(running.baseUrl, config.adminApiKey, 'GET', '/admin/pool');
    console.log(`Pool: ${before.body.pool.fee.free} free fee UTxOs, ${collateralSummary(before.body.pool)}, reserve ${before.body.reserve.lovelace} lovelace`);
    let replenish: ReplenishBody | undefined;
    if (before.body.pool.fee.free < MINIMUM_FREE_FEE_UTXOS || !before.body.pool.collateral.shared) {
      const collateralWanted = Math.max(0, REPLENISH_COLLATERAL_UTXOS - collateralCount(before.body.pool));
      console.log(`Replenishing the pool with ${REPLENISH_FEE_UTXOS} fee and ${collateralWanted} collateral UTxOs; this waits for confirmation`);
      const answer = await call<ReplenishBody>(running.baseUrl, config.adminApiKey, 'POST', '/admin/pool/replenish', {
        feeUtxoCount: REPLENISH_FEE_UTXOS,
        collateralCount: collateralWanted,
      });
      if (answer.status !== 200 || answer.body.txId === null) {
        throw new Error(`Replenishing answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      }
      replenish = answer.body;
      attempted.push({ hash: answer.body.txId, role: 'pool replenishment' });
      console.log(`Replenished: ${answer.body.txId}`);
    }

    console.log('Step 1: sponsored account creation in fee mode');
    const sponsor = new SponsorWallet({ baseUrl: running.baseUrl, apiKey, provider });
    const creationTx = await createAccount({ owner: owner.keyHash, wallet: owner.wallet, sponsor, provider, state: initialState(owner.keyHash) });
    const lease = sponsor.lease;
    if (lease === undefined) {
      throw new Error('The sponsor wallet holds no lease after building');
    }
    console.log(`  built on lease ${lease.leaseId}, fee UTxO ${lease.fee.txHash}#${lease.fee.index}`);
    const creation = creationAmounts(parsed(creationTx), lease, owner, config.slots);
    attempted.push({ hash: parsed(creationTx).hash, role: 'sponsored account creation' });
    const creationTxId = await submit(provider, [sponsor, owner.wallet], creationTx);
    console.log(`  submitted ${creationTxId}`);
    await settle(provider, creationTxId, parsed(creationTx));
    let controlUtxo: UTxO | undefined;
    await waitUntil('the control UTxO at the account address', async () => {
      const utxos = await provider.getUnspentOutputs(owner.account.address);
      controlUtxo = utxos.find((utxo) => utxo.input.txId === creationTxId && (utxo.output.value.assets?.[owner.account.stateNftAssetId] ?? 0n) === 1n);
      return controlUtxo !== undefined;
    });
    let changeUtxo: UTxO | undefined;
    await waitUntil('the sponsor change UTxO', async () => {
      const utxos = await provider.getUnspentOutputs(running.sponsorAddress);
      changeUtxo = utxos.find((utxo) => utxo.input.txId === creationTxId && utxo.output.value.coins === creation.change);
      return changeUtxo !== undefined;
    });
    await waitUntil('the stake credential to be registered', () => isStakeCredentialRegistered(config.blockfrostProjectId, owner.account.rewardAddress));
    if (controlUtxo === undefined || changeUtxo === undefined) {
      throw new Error('The chain does not show the creation outputs');
    }
    console.log(`  on chain: control UTxO ${ref(controlUtxo)}, sponsor change ${ref(changeUtxo)}, stake credential registered`);

    console.log(`Step 2: deposit of ${DEPOSIT_LOVELACE} lovelace from the funding wallet's reserve`);
    const reserve = running.reserveUtxos();
    const depositTx = await (await funding.createTransactionBuilder())
      .setUtxos(reserve)
      .sendLovelace({ address: owner.account.address, amount: DEPOSIT_LOVELACE })
      .build();
    const depositParsed = parsed(depositTx);
    const outsidePool = new Set(reserve.map(ref));
    const touched = depositParsed.inputs.map(inputRef).filter((input) => !outsidePool.has(input));
    if (touched.length > 0) {
      throw new Error(`The deposit spends ${touched.join(', ')}, which is not in the reserve`);
    }
    attempted.push({ hash: depositParsed.hash, role: 'deposit' });
    const depositTxId = await submit(provider, [funding], depositTx);
    console.log(`  submitted ${depositTxId}`);
    await settle(provider, depositTxId, depositParsed);

    const clock = { now: new Date() };
    const collateral = new SponsorWallet({ baseUrl: running.baseUrl, apiKey, provider, mode: 'collateral', now: () => clock.now });
    const presetBound = (shared: CollateralBody): bigint => slotAt(config.slots, presetCollateralBound(shared, clock.now));
    const accountRefs = async (): Promise<Set<string>> => new Set((await provider.getUnspentOutputs(owner.account.address)).map(ref));
    const operate = async (role: string, signer: Wallet, build: () => Promise<string>, expectedBound: (shared: CollateralBody) => bigint = presetBound): Promise<Operation> => {
      const held = await accountRefs();
      clock.now = new Date();
      const tx = await build();
      const shared = collateral.collateral;
      if (shared === undefined) {
        throw new Error('The collateral wallet holds no shared collateral after building');
      }
      const amounts = operationAmounts(parsed(tx), owner.account, held, shared, expectedBound(shared));
      attempted.push({ hash: parsed(tx).hash, role });
      const txId = await submit(provider, [collateral, signer], tx);
      console.log(`  submitted ${txId}, fee ${amounts.fee} paid by the account, collateral ${ref(shared)}`);
      await settle(provider, txId, parsed(tx));
      const { state } = await findAccountUtxos(provider, { record, wallet: signer });
      return { txId, amounts, state };
    };

    console.log(`Step 3: owner spend of ${OWNER_SPEND_LOVELACE} lovelace to the recipient, paid from the account`);
    const ownerSpend = await operate('owner spend paid from the account', owner.wallet, () =>
      spendWithDevice({ owner: owner.keyHash, wallet: owner.wallet, collateral, provider, outputs: [{ address: recipient.address, value: { coins: OWNER_SPEND_LOVELACE } }] }),
    );

    console.log(`Step 4: grant in slot ${GRANT_SLOT} to the agent key, paid from the account`);
    const grant: Grant = {
      slot: GRANT_SLOT,
      grantee: agent.keyHash,
      scope: {
        asset: LOVELACE,
        perCallCap: GRANT_CAP,
        cap: GRANT_CAP,
        lovelacePerCallCap: 0n,
        lovelaceCap: 0n,
        expiresAt: BigInt(Date.now()) + GRANT_LIFETIME_MS,
        recipients: [recipient.address],
      },
    };
    const grantIssued = await operate('grant issued, paid from the account', owner.wallet, () =>
      issueGrant({ owner: owner.keyHash, wallet: owner.wallet, collateral, provider, grant }),
    );

    let agentValidUntilSlot = 0n;
    const grantSpend = (lovelace: bigint, unchecked: boolean): Promise<string> => {
      agentValidUntilSlot = currentSlot() + AGENT_VALIDITY_SLOTS;
      return spendWithGrant({
        record,
        wallet: agent.wallet,
        collateral,
        provider,
        slot: GRANT_SLOT,
        grantee: agent.keyHash,
        outputs: [{ address: recipient.address, value: { coins: lovelace } }],
        validUntilSlot: agentValidUntilSlot,
        unchecked,
      });
    };

    console.log(`Step 5: agent spend of ${AGENT_SPEND_LOVELACE} lovelace within the cap, paid from the account`);
    const agentSpend = await operate(
      'agent spend within the cap, paid from the account',
      agent.wallet,
      () => grantSpend(AGENT_SPEND_LOVELACE, false),
      () => agentValidUntilSlot,
    );

    console.log(`Step 6: agent spend of ${OVER_CAP_SPEND_LOVELACE} lovelace over the cap, built unchecked`);
    const overCapTx = await grantSpend(OVER_CAP_SPEND_LOVELACE, true);
    const overCapTxHash = parsed(overCapTx).hash;
    attempted.push({ hash: overCapTxHash, role: 'agent spend over the cap, refused by the service, never submitted' });
    const overCap = await collateral.signTransaction(overCapTx, true).then(
      () => undefined,
      (err: unknown) => err,
    );
    if (!(overCap instanceof SponsorError)) {
      throw new Error('The service witnessed an agent spend over the cap');
    }
    if (overCap.status !== 422 || overCap.rule !== 'evaluates') {
      throw new Error(`The over cap spend was refused as ${overCap.status} ${overCap.code} ${overCap.rule ?? ''} instead of 422 evaluates`);
    }
    const overCapRefusal: Refusal = { description: 'The agent spend over the cap, presented to the collateral witness route', status: overCap.status, body: refusalBody(overCap) };
    console.log(`  refused as expected: ${overCap.status} ${overCap.code} ${overCap.rule}`);

    console.log(`Step 7: grant in slot ${GRANT_SLOT} revoked, paid from the account`);
    const revoked = await operate('grant revoked, paid from the account', owner.wallet, () =>
      revokeGrant({ owner: owner.keyHash, wallet: owner.wallet, collateral, provider, slot: GRANT_SLOT }),
    );
    if (revoked.state.grants.length !== 0) {
      throw new Error('The account still holds a grant after the revocation');
    }

    console.log('Step 8: refused creations in fee mode');
    const leaking = new LeakingSponsorWallet({ baseUrl: running.baseUrl, apiKey, provider }, owner.address, LEAK_LOVELACE);
    const leakingTx = await createAccount({
      owner: recipient.keyHash,
      wallet: recipient.wallet,
      sponsor: leaking,
      provider,
      state: initialState(recipient.keyHash),
    });
    const leakingTxHash = parsed(leakingTx).hash;
    attempted.push({ hash: leakingTxHash, role: 'creation leaking sponsor value, refused by the service, never submitted' });
    const creationRefusals: Refusal[] = [];
    const outcome = await leaking.signTransaction(leakingTx, true).then(
      () => undefined,
      (err: unknown) => err,
    );
    if (!(outcome instanceof SponsorError)) {
      throw new Error('The service witnessed a creation that pays sponsor value to a third party');
    }
    creationRefusals.push({
      description: 'The creation paying sponsor value to a third party, on a fresh lease',
      status: outcome.status,
      body: refusalBody(outcome),
    });
    console.log(`  refused as expected: ${outcome.status} ${outcome.code} ${outcome.rule ?? ''}`);
    await leaking.release();

    const reuse = await call<Record<string, unknown>>(running.baseUrl, apiKey, 'POST', `/v1/leases/${lease.leaseId}/witness`, { transaction: leakingTx });
    creationRefusals.push({ description: 'The same transaction presented on the lease the creation consumed', status: reuse.status, body: reuse.body });
    console.log(`  refused as expected: ${reuse.status} ${String(reuse.body.error)}`);
    if (outcome.status !== 422 || outcome.rule !== 'sponsor_outflow_bounded' || reuse.status !== 409 || reuse.body.error !== 'lease_consumed') {
      throw new Error('A refused case did not answer as documented');
    }

    const after = await call<PoolBody>(running.baseUrl, config.adminApiKey, 'GET', '/admin/pool');
    const audit = await call<{ entries: RecordedAuditEntry[] }>(running.baseUrl, config.adminApiKey, 'GET', '/admin/audit?limit=1000');
    const issuedEntries = audit.body.entries.filter((entry) => entry.action === 'witness' && entry.outcome === 'issued');
    const evidence: Evidence = {
      ranAt: new Date().toISOString(),
      sponsorAddress: running.sponsorAddress,
      accountScriptHash: config.accountScriptHash,
      poolBefore: before.body.pool,
      replenish,
      poolAfter: after.body.pool,
      owner,
      agent,
      recipient,
      lease,
      creationTxId,
      creation,
      controlUtxo,
      changeUtxo,
      creationAudit: issuedEntries.find((entry) => entry.detail['txHash'] === creationTxId),
      depositTxId,
      depositFee: depositParsed.fee,
      ownerSpend,
      grant,
      grantIssued,
      agentSpend,
      overCapTxHash,
      overCapRefusal,
      revoked,
      leakingTxHash,
      creationRefusals,
      collateralAudit: issuedEntries.filter((entry) => entry.detail['mode'] === 'collateral'),
    };
    mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
    writeFileSync(EVIDENCE_PATH, evidenceDocument(evidence));
    console.log(`Evidence written to ${EVIDENCE_PATH}`);
  } finally {
    for (const { hash, role } of attempted) {
      console.log(`Transaction ${hash}: ${role}`);
    }
    await running.stop();
  }
};

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`Preprod proof failed: ${message}`);
  process.exit(1);
});
