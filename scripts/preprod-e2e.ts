import './shared-cometa.js';
import { randomBytes } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Provider, TransactionBuilder, UTxO, Wallet } from '@biglup/cometa';
import { type AccountState, type DiscoveredAccount, accountByOwner, createAccount, paymentKeyHashOf } from 'cardano-account-custody-offchain';
import { config as loadEnvFile } from 'dotenv';
import { SponsorError, SponsorWallet, type SponsorWalletOptions } from '../src/client/sponsor-wallet.js';
import { Cometa } from '../src/cometa.js';
import { type Config, loadConfig } from '../src/config.js';
import type { RecordedAuditEntry } from '../src/audit.js';
import type { PoolCounts } from '../src/http/health.js';
import type { LeaseBody } from '../src/api.js';
import { createLogger } from '../src/logger.js';
import { type ParsedTransaction, parseTransaction } from '../src/policy/parse.js';
import { createService } from '../src/service.js';

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

/** The first account index of the sponsor mnemonic tried for an owner wallet, and how many are tried. */
const FIRST_OWNER_ACCOUNT = 10;
const OWNER_ACCOUNT_CANDIDATES = 50;

/** The pool the run wants to find, and what it asks for when the pool is short. */
const MINIMUM_FREE_FEE_UTXOS = 3;
const REPLENISH_FEE_UTXOS = 5;
const REPLENISH_COLLATERAL_UTXOS = 2;

/** The sponsor lovelace the refused creation tries to pay a third party. */
const LEAK_LOVELACE = 5_000_000n;

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

/** An owner wallet of the run: empty, at an account index of the sponsor mnemonic, with the account its key fixes. */
interface Owner {
  index: number;
  wallet: Wallet;
  address: string;
  keyHash: string;
  account: DiscoveredAccount;
}

/**
 * The first `count` owner wallets, from the candidate account indexes of
 * the mnemonic, whose stake credential is not registered. A credential
 * stays registered for as long as its account exists, and an account is
 * never deleted, so an owner key that already created an account can
 * never create another, and every run takes fresh ones. The wallets hold
 * nothing: the sponsor pays for everything.
 */
const freshOwners = async (provider: Provider, config: Config, mnemonics: string[], count: number): Promise<Owner[]> => {
  const owners: Owner[] = [];
  for (let index = FIRST_OWNER_ACCOUNT; index < FIRST_OWNER_ACCOUNT + OWNER_ACCOUNT_CANDIDATES && owners.length < count; index += 1) {
    const wallet = await walletOf(provider, mnemonics, index);
    const address = (await wallet.getChangeAddress()).toString();
    const keyHash = paymentKeyHashOf(address);
    if (keyHash === undefined) {
      throw new Error('The owner wallet did not derive a key address');
    }
    const account = accountByOwner(keyHash);
    if (!account.stateNftAssetId.startsWith(config.accountScriptHash)) {
      throw new Error(`The linked contract library derives account script ${account.stateNftAssetId.slice(0, 56)} but the service is configured for ${config.accountScriptHash}`);
    }
    if (!(await isStakeCredentialRegistered(config.blockfrostProjectId, account.rewardAddress))) {
      owners.push({ index, wallet, address, keyHash, account });
    }
  }
  if (owners.length < count) {
    throw new Error(`Fewer than ${count} owner account indexes from ${FIRST_OWNER_ACCOUNT} onwards have an unregistered stake credential`);
  }
  return owners;
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

/** What the sponsored creation cost and who paid, read off the transaction and the lease it was built on. */
interface CreationAmounts {
  fee: bigint;
  deposit: bigint;
  controlLovelace: bigint;
  change: bigint;
  sponsored: bigint;
  invalidHereafter: bigint;
}

/** Reads the creation amounts off the transaction and checks that the sponsor paid exactly the fee, the deposit and the control output. */
const creationAmounts = (tx: ParsedTransaction, lease: LeaseBody, owner: Owner): CreationAmounts => {
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
  return { fee: tx.fee, deposit: registration.deposit, controlLovelace: control.lovelace, change, sponsored, invalidHereafter: tx.invalidHereafter };
};

/** Everything the evidence document reports. */
interface Evidence {
  ranAt: string;
  sponsorAddress: string;
  accountScriptHash: string;
  poolBefore: PoolCounts;
  replenish: ReplenishBody | undefined;
  poolAfter: PoolCounts;
  owner: Owner;
  lease: LeaseBody;
  txId: string;
  amounts: CreationAmounts;
  controlUtxo: UTxO;
  changeUtxo: UTxO;
  audit: RecordedAuditEntry | undefined;
  refusals: Refusal[];
  leakingOwner: Owner;
  leakingTxHash: string;
}

/** A UTxO reference as the document prints it. */
const ref = (utxo: UTxO): string => `${utxo.input.txId}#${utxo.input.index}`;

/** The evidence document. */
const evidenceDocument = (evidence: Evidence): string => {
  const { owner, lease, amounts, leakingOwner } = evidence;
  const lines = [
    '# Preprod evidence',
    '',
    `A custody account created on preprod on ${evidence.ranAt} with the fee sponsor service paying the fee, the registration`,
    'deposit and the control UTxO, and providing the collateral, for an owner wallet that holds no ADA. The service ran',
    'against preprod with its funding wallet, a client key was issued through the admin route, and the client created the',
    "account through the contract's own builder with the sponsor wallet adapter as the sponsor.",
    '',
    '## Setup',
    '',
    `- Sponsor address: \`${evidence.sponsorAddress}\``,
    `- Account script hash: \`${evidence.accountScriptHash}\``,
    `- Pool before the run: ${evidence.poolBefore.fee.free} free fee UTxOs, ${evidence.poolBefore.collateral.free} free collateral UTxOs`,
    evidence.replenish?.txId
      ? `- Replenished with ${evidence.replenish.feeOutputs} fee and ${evidence.replenish.collateralOutputs} collateral UTxOs: ${link(evidence.replenish.txId)}`
      : '- No replenishment was needed',
    `- Pool after the run: ${evidence.poolAfter.fee.free} free fee UTxOs, ${evidence.poolAfter.collateral.free} free collateral UTxOs`,
    '',
    '## Sponsored account creation',
    '',
    `- Owner wallet: account index ${owner.index} of the sponsor mnemonic, address \`${owner.address}\`, holding no ADA`,
    `- Owner key hash: \`${owner.keyHash}\``,
    `- Account address: \`${owner.account.address}\``,
    `- Stake credential: \`${owner.account.stakeScriptHash}\`, reward address \`${owner.account.rewardAddress}\``,
    `- State NFT: \`${owner.account.stateNftAssetId}\``,
    `- Lease \`${lease.leaseId}\`, expiring ${lease.expiresAt}: fee UTxO \`${lease.fee.txHash}#${lease.fee.index}\` of ${ada(lease.fee.lovelace)},`,
    `  collateral UTxO \`${lease.collateral.txHash}#${lease.collateral.index}\` of ${ada(lease.collateral.lovelace)}`,
    `- Validity upper bound: slot ${amounts.invalidHereafter}, the lease expiry, as the adapter presets it`,
    `- Transaction: ${link(evidence.txId)}`,
    '',
    '| Amount | Lovelace |',
    '| ------ | -------- |',
    `| Fee | ${ada(amounts.fee)} |`,
    `| Stake registration deposit | ${ada(amounts.deposit)} |`,
    `| Control UTxO | ${ada(amounts.controlLovelace)} |`,
    `| Sponsor change | ${ada(amounts.change)} |`,
    `| Sponsored in total | ${ada(amounts.sponsored)} |`,
    '',
    `The fee UTxO held ${ada(lease.fee.lovelace)}; the change back to the sponsor leaves exactly the fee, the deposit and the`,
    'control UTxO sponsored, which is what the sponsor outflow rule requires of a creation.',
    '',
    'On chain after confirmation:',
    '',
    `- The control UTxO \`${ref(evidence.controlUtxo)}\` sits at the account address holding ${ada(evidence.controlUtxo.output.value.coins)} and the state NFT`,
    `- The stake credential is registered: Blockfrost lists the reward address as registered, active from the next epoch`,
    `- The sponsor change UTxO \`${ref(evidence.changeUtxo)}\` holds ${ada(evidence.changeUtxo.output.value.coins)}`,
    evidence.audit
      ? `- The audit trail records the witness as issued: \`${JSON.stringify(evidence.audit.detail)}\``
      : '- The audit trail entry for the witness was not found',
    '',
    '## Refused transactions',
    '',
    `A second creation, for the owner at account index ${leakingOwner.index} (\`${leakingOwner.address}\`), built with a sponsor wallet`,
    `that slips a ${ada(LEAK_LOVELACE)} payment to the first owner's address into every builder, so that the creation`,
    'also pays sponsor value to a third party. Its hash is',
    `\`${evidence.leakingTxHash}\`; it was never submitted.`,
    '',
    ...evidence.refusals.flatMap((refusal, index) => [
      `${index + 1}. ${refusal.description}: HTTP ${refusal.status}`,
      '',
      '   ```json',
      ...JSON.stringify(refusal.body, null, 2)
        .split('\n')
        .map((line) => `   ${line}`),
      '   ```',
      '',
    ]),
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

  const [owner, leakingOwner] = await freshOwners(provider, config, config.sponsorMnemonic, 2);
  if (owner === undefined || leakingOwner === undefined) {
    throw new Error('Two fresh owners are needed');
  }
  console.log(`Owner wallet: account index ${owner.index} of the mnemonic, ${owner.address}`);
  console.log(`Account address: ${owner.account.address}`);
  console.log(`Second owner for the refused creation: account index ${leakingOwner.index}, ${leakingOwner.address}`);

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
    console.log(`Pool: ${before.body.pool.fee.free} free fee UTxOs, ${before.body.pool.collateral.free} free collateral UTxOs, reserve ${before.body.reserve.lovelace} lovelace`);
    let replenish: ReplenishBody | undefined;
    if (before.body.pool.fee.free < MINIMUM_FREE_FEE_UTXOS) {
      const collateralCount = Math.max(0, REPLENISH_COLLATERAL_UTXOS - before.body.pool.collateral.free);
      console.log(`Replenishing the pool with ${REPLENISH_FEE_UTXOS} fee and ${collateralCount} collateral UTxOs; this waits for confirmation`);
      const answer = await call<ReplenishBody>(running.baseUrl, config.adminApiKey, 'POST', '/admin/pool/replenish', {
        feeUtxoCount: REPLENISH_FEE_UTXOS,
        collateralCount,
      });
      if (answer.status !== 200 || answer.body.txId === null) {
        throw new Error(`Replenishing answered ${answer.status}: ${JSON.stringify(answer.body)}`);
      }
      replenish = answer.body;
      attempted.push({ hash: answer.body.txId, role: 'pool replenishment' });
      console.log(`Replenished: ${answer.body.txId}`);
    }

    const sponsor = new SponsorWallet({ baseUrl: running.baseUrl, apiKey, provider });
    const tx = await createAccount({ owner: owner.keyHash, wallet: owner.wallet, sponsor, provider, state: initialState(owner.keyHash) });
    const lease = sponsor.lease;
    if (lease === undefined) {
      throw new Error('The sponsor wallet holds no lease after building');
    }
    console.log(`Built the creation on lease ${lease.leaseId}, fee UTxO ${lease.fee.txHash}#${lease.fee.index}`);
    const amounts = creationAmounts(parsed(tx), lease, owner);
    const witnesses = [...(await sponsor.signTransaction(tx, true)), ...(await owner.wallet.signTransaction(tx, true))];
    const signed = Cometa.applyVkeyWitnessSet(tx, witnesses);
    attempted.push({ hash: parsed(signed).hash, role: 'sponsored account creation' });
    const txId = await sponsor.submitTransaction(signed);
    console.log(`Submitted the creation: ${txId}`);
    if (!(await provider.confirmTransaction(txId, CONFIRMATION_TIMEOUT_MS))) {
      throw new Error(`Transaction ${txId} was not confirmed within ${CONFIRMATION_TIMEOUT_MS / 1000} seconds`);
    }
    console.log('Confirmed');

    let controlUtxo: UTxO | undefined;
    await waitUntil('the control UTxO at the account address', async () => {
      const utxos = await provider.getUnspentOutputs(owner.account.address);
      controlUtxo = utxos.find((utxo) => utxo.input.txId === txId && (utxo.output.value.assets?.[owner.account.stateNftAssetId] ?? 0n) === 1n);
      return controlUtxo !== undefined;
    });
    let changeUtxo: UTxO | undefined;
    await waitUntil('the sponsor change UTxO', async () => {
      const utxos = await provider.getUnspentOutputs(running.sponsorAddress);
      changeUtxo = utxos.find((utxo) => utxo.input.txId === txId && utxo.output.value.coins === amounts.change);
      return changeUtxo !== undefined;
    });
    await waitUntil('the stake credential to be registered', () => isStakeCredentialRegistered(config.blockfrostProjectId, owner.account.rewardAddress));
    if (controlUtxo === undefined || changeUtxo === undefined) {
      throw new Error('The chain does not show the creation outputs');
    }
    console.log(`On chain: control UTxO ${ref(controlUtxo)}, sponsor change ${ref(changeUtxo)}, stake credential registered`);

    const leaking = new LeakingSponsorWallet({ baseUrl: running.baseUrl, apiKey, provider }, owner.address, LEAK_LOVELACE);
    const leakingTx = await createAccount({
      owner: leakingOwner.keyHash,
      wallet: leakingOwner.wallet,
      sponsor: leaking,
      provider,
      state: initialState(leakingOwner.keyHash),
    });
    const leakingTxHash = parsed(leakingTx).hash;
    const refusals: Refusal[] = [];
    const outcome = await leaking.signTransaction(leakingTx, true).then(
      () => undefined,
      (err: unknown) => err,
    );
    if (!(outcome instanceof SponsorError)) {
      throw new Error('The service witnessed a creation that pays sponsor value to a third party');
    }
    refusals.push({
      description: 'The creation paying sponsor value to a third party, on a fresh lease',
      status: outcome.status,
      body: { error: outcome.code, rule: outcome.rule, detail: outcome.detail },
    });
    console.log(`Refused as expected: ${outcome.status} ${outcome.code} ${outcome.rule ?? ''}`);
    await leaking.release();

    const reuse = await call<Record<string, unknown>>(running.baseUrl, apiKey, 'POST', `/v1/leases/${lease.leaseId}/witness`, { transaction: leakingTx });
    refusals.push({ description: 'The same transaction presented on the lease the creation consumed', status: reuse.status, body: reuse.body });
    console.log(`Refused as expected: ${reuse.status} ${String(reuse.body.error)}`);
    if (outcome.status !== 422 || outcome.rule !== 'sponsor_outflow_bounded' || reuse.status !== 409 || reuse.body.error !== 'lease_consumed') {
      throw new Error('A refused case did not answer as documented');
    }

    const after = await call<PoolBody>(running.baseUrl, config.adminApiKey, 'GET', '/admin/pool');
    const audit = await call<{ entries: RecordedAuditEntry[] }>(running.baseUrl, config.adminApiKey, 'GET', '/admin/audit?limit=1000');
    const evidence: Evidence = {
      ranAt: new Date().toISOString(),
      sponsorAddress: running.sponsorAddress,
      accountScriptHash: config.accountScriptHash,
      poolBefore: before.body.pool,
      replenish,
      poolAfter: after.body.pool,
      owner,
      lease,
      txId,
      amounts,
      controlUtxo,
      changeUtxo,
      audit: audit.body.entries.find((entry) => entry.action === 'witness' && entry.outcome === 'issued' && entry.detail['txHash'] === txId),
      refusals,
      leakingOwner,
      leakingTxHash,
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
