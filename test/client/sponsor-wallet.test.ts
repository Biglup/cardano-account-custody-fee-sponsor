import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { UTxO, Wallet } from '@biglup/cometa';
import { SponsorError, SponsorWallet } from '../../src/client/sponsor-wallet.js';
import { Cometa } from '../../src/cometa.js';
import { parseTransaction } from '../../src/policy/parse.js';
import { slotAt } from '../../src/slots.js';
import { accountAddress, fundRedeemer, fundUtxo, initialStateOf, stateNftAssetId, strangerAddress } from '../support/account.js';
import { shapeCreation, shapeOwnerOperation, sponsorUtxo } from '../support/client.js';
import { appFetch } from '../support/http.js';
import { TEST_MNEMONIC, type TestService, createTestService, txHash } from '../support/service.js';

let service: TestService;
let apiKey: string;
let sponsor: SponsorWallet;

beforeEach(async () => {
  service = await createTestService();
  apiKey = service.issueKey().apiKey;
  sponsor = new SponsorWallet({ baseUrl: 'http://sponsor.test/', apiKey, provider: service.provider, fetch: appFetch(service.app), now: () => service.clock.now });
});

afterEach(() => {
  service.close();
});

/** Funds `fee` fee UTxOs and `collateral` collateral UTxOs and syncs the pool. */
const fundPool = async (fee = 1, collateral = 1): Promise<void> => {
  for (let i = 0; i < fee; i += 1) {
    service.fund(txHash(100 + i), 0, 100_000_000n);
  }
  for (let i = 0; i < collateral; i += 1) {
    service.fund(txHash(200 + i), 0, 5_000_000n);
  }
  await service.sync.run();
};

/** The status of every lease taken so far, in the order they were taken. */
const leaseStatuses = (): string[] =>
  (service.db.prepare('SELECT status FROM leases ORDER BY rowid').all() as { status: string }[]).map((row) => row.status);

/** The password cometa encrypts the owner's keys with, fresh for every test run. */
const ownerPassword = randomBytes(32);

/** An owner wallet of the test mnemonic at an account index the sponsor never uses, holding nothing on the fake chain. */
const ownerWallet = (): Promise<Wallet> =>
  Cometa.SingleAddressWallet.createFromMnemonics({
    mnemonics: TEST_MNEMONIC.split(' '),
    provider: service.provider,
    getPassword: () => Promise.resolve(new Uint8Array(ownerPassword)),
    credentialsConfig: { account: 10, paymentIndex: 0, stakingIndex: 0 },
  });

/** The payment key hash of a wallet's address. */
const paymentKeyHashOf = async (wallet: Wallet): Promise<string> => {
  const credential = (await wallet.getChangeAddress()).asBase()?.getPaymentCredential();
  if (credential === undefined) {
    throw new Error('The wallet address is not a base address');
  }
  return credential.hash;
};

/** The hash of a verification key, as a credential names it. */
const keyHashOf = (vkey: string): string => Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(vkey), 28));

/** The key hashes of the verification key witnesses a signed transaction carries, sorted. */
const signersOf = (signed: string): string[] =>
  (Cometa.inspectTx(signed).witness_set.vkey_witnesses as { vkey: string }[]).map((witness) => keyHashOf(witness.vkey)).sort();

/** A sponsor wallet in collateral mode over the test service. */
const collateralSponsor = (): SponsorWallet =>
  new SponsorWallet({ baseUrl: 'http://sponsor.test', apiKey, provider: service.provider, mode: 'collateral', fetch: appFetch(service.app), now: () => service.clock.now });

/** The account of `device` on the fake chain: its control UTxO with the state naming that one device, and a fund UTxO of 20 ADA. */
const placeAccountOf = (device: string): { control: UTxO; fund: UTxO } => {
  const control: UTxO = {
    input: { txId: txHash(300), index: 0 },
    output: { address: accountAddress, value: { coins: 2_000_000n, assets: { [stateNftAssetId]: 1n } }, datum: initialStateOf(device) },
  };
  const fund = fundUtxo(txHash(301), 20_000_000n);
  service.provider.addUtxo(control);
  service.provider.addUtxo(fund);
  return { control, fund };
};

/** An owner operation the account pays for, built on the collateral mode sponsor's builder: the control and a fund UTxO in, the change back to the account. */
const buildAccountPaid = async (sponsor: SponsorWallet, device: string, control: UTxO, fund: UTxO): Promise<string> => {
  const builder = shapeOwnerOperation((await sponsor.createTransactionBuilder()).setChangeAddress(accountAddress), control, device);
  return builder.addInput({ utxo: fund, redeemer: fundRedeemer }).build();
};

describe('SponsorWallet', () => {
  it('takes a lease on first use and answers every question about itself from it', async () => {
    await fundPool();
    expect(sponsor.lease).toBeUndefined();
    expect(leaseStatuses()).toEqual([]);

    const address = await sponsor.getAddress();

    expect(address.toString()).toBe(service.serviceWallet.address);
    expect(leaseStatuses()).toEqual(['open']);
    const lease = sponsor.lease;
    expect(lease).toMatchObject({ sponsorAddress: service.serviceWallet.address, fee: { txHash: txHash(100) }, collateral: { txHash: txHash(200) } });
    expect(await sponsor.getUnspentOutputs()).toEqual([sponsorUtxo(lease?.fee ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    expect(await sponsor.getCollateral()).toEqual([sponsorUtxo(lease?.collateral ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    expect(await sponsor.getBalance()).toEqual({ coins: 100_000_000n });
    expect((await sponsor.getChangeAddress()).toString()).toBe(service.serviceWallet.address);
    expect(await sponsor.getNetworkId()).toBe(Cometa.NetworkId.Testnet);
    expect(leaseStatuses()).toEqual(['open']);
  });

  it('holds one lease when asked several things at once on first use', async () => {
    await fundPool(3, 1);

    const [address, utxos, collateral] = await Promise.all([sponsor.getAddress(), sponsor.getUnspentOutputs(), sponsor.getCollateral()]);

    expect(leaseStatuses()).toEqual(['open']);
    const lease = sponsor.lease;
    expect(address.toString()).toBe(lease?.sponsorAddress);
    expect(utxos).toEqual([sponsorUtxo(lease?.fee ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    expect(collateral).toEqual([sponsorUtxo(lease?.collateral ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    const health = await request(service.app).get('/health');
    expect(health.body.pool.fee).toEqual({ free: 2, leased: 1 });
  });

  it('refuses every use waiting on a lease the service does not grant, and tries again on the next use', async () => {
    const refusals = await Promise.allSettled([sponsor.getAddress(), sponsor.getUnspentOutputs()]);

    expect(refusals.map((outcome) => outcome.status)).toEqual(['rejected', 'rejected']);
    expect(refusals[0]).toMatchObject({ reason: { status: 503, code: 'out_of_funds' } });
    expect(sponsor.lease).toBeUndefined();

    await fundPool();
    await sponsor.getAddress();

    expect(leaseStatuses()).toEqual(['open']);
  });

  it('presets the validity upper bound of its builders at the lease expiry, which the service accepts', async () => {
    await fundPool();

    const transaction = await shapeCreation(await sponsor.createTransactionBuilder()).build();

    const lease = sponsor.lease;
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.invalidHereafter).toBe(slotAt(service.config.slots, new Date(lease?.expiresAt ?? '')));
    const witnesses = await sponsor.signTransaction(transaction, true);
    expect(witnesses).toHaveLength(1);
  });

  it('witnesses a creation built through it, and the merged transaction carries the sponsor and owner signatures', async () => {
    await fundPool();
    const owner = await ownerWallet();
    const ownerKey = await paymentKeyHashOf(owner);
    const transaction = await shapeCreation(await sponsor.createTransactionBuilder(), { device: ownerKey }).build();
    const leaseId = sponsor.lease?.leaseId;

    const sponsorWitnesses = await sponsor.signTransaction(transaction, true);
    const ownerWitnesses = await owner.signTransaction(transaction, true);
    const signed = Cometa.applyVkeyWitnessSet(transaction, [...sponsorWitnesses, ...ownerWitnesses]);

    expect(signersOf(signed)).toEqual([service.serviceWallet.paymentKeyHash, ownerKey].sort());
    expect(service.db.prepare('SELECT status FROM leases WHERE id = ?').get(leaseId)).toEqual({ status: 'consumed' });
    expect(sponsor.lease).toBeUndefined();
    expect(await sponsor.submitTransaction(signed)).toMatch(/^[0-9a-f]{64}$/);
    expect(service.provider.submitted).toEqual([signed]);
  });

  it('reads the protocol parameters for every builder', async () => {
    await fundPool();
    const getParameters = vi.spyOn(service.provider, 'getParameters');

    await sponsor.createTransactionBuilder();
    await sponsor.createTransactionBuilder();

    expect(getParameters).toHaveBeenCalledTimes(2);
  });

  it('answers a repeat of the witnessed transaction from the lease it consumed, and takes a new lease for the next one', async () => {
    await fundPool(2, 1);
    const transaction = await shapeCreation(await sponsor.createTransactionBuilder()).build();
    const first = await sponsor.signTransaction(transaction, true);

    const again = await sponsor.signTransaction(transaction, true);

    expect(again).toEqual(first);
    expect(leaseStatuses()).toEqual(['consumed']);
    const outcomes = (service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness' ORDER BY id").all() as { outcome: string }[]).map(
      (row) => row.outcome,
    );
    expect(outcomes).toEqual(['issued', 'reissued']);

    const next = await shapeCreation(await sponsor.createTransactionBuilder()).build();
    await sponsor.signTransaction(next, true);
    expect(leaseStatuses()).toEqual(['consumed', 'consumed']);
  });

  it('surfaces a refusal as a SponsorError naming the rule, and keeps the lease for a corrected transaction', async () => {
    await fundPool();
    const builder = await sponsor.createTransactionBuilder();
    const transaction = await shapeCreation(builder, { customise: (shaped) => shaped.sendLovelace({ address: strangerAddress, amount: 5_000_000n }) }).build();
    const leaseId = sponsor.lease?.leaseId;

    const refusal = await sponsor.signTransaction(transaction, true).catch((err: unknown) => err);

    expect(refusal).toBeInstanceOf(SponsorError);
    expect(refusal).toMatchObject({
      status: 422,
      code: 'invalid_transaction',
      rule: 'sponsor_outflow_bounded',
      detail: expect.stringMatching(/drawn down by/),
      message: expect.stringMatching(/^invalid_transaction \(sponsor_outflow_bounded\): /),
    });
    expect(sponsor.lease?.leaseId).toBe(leaseId);
    expect(leaseStatuses()).toEqual(['open']);
  });

  it('surfaces a refused key and an answer that is not the service as SponsorErrors', async () => {
    await fundPool();
    const stranger = new SponsorWallet({ baseUrl: 'http://sponsor.test', apiKey: 'not-a-key', provider: service.provider, fetch: appFetch(service.app) });
    await expect(stranger.getAddress()).rejects.toMatchObject({ status: 401, code: 'unauthorized' });

    const proxied = new SponsorWallet({
      baseUrl: 'http://sponsor.test',
      apiKey,
      provider: service.provider,
      fetch: () => Promise.resolve(new Response('<html>Bad gateway</html>', { status: 502 })),
    });
    await expect(proxied.getAddress()).rejects.toMatchObject({ status: 502, code: 'unexpected_response' });
  });

  it('releases what a lease request in flight resolves to, so it holds nothing afterwards', async () => {
    await fundPool();
    const taking = sponsor.getAddress();

    await sponsor.release();

    expect(sponsor.lease).toBeUndefined();
    expect(leaseStatuses()).toEqual(['released']);
    expect((await taking).toString()).toBe(service.serviceWallet.address);
    const health = await request(service.app).get('/health');
    expect(health.body.pool.fee).toEqual({ free: 1, leased: 0 });
  });

  it('releases an unused lease, and releasing again or without a lease does nothing', async () => {
    await fundPool();
    await sponsor.getAddress();
    const leaseId = sponsor.lease?.leaseId;

    await sponsor.release();

    expect(sponsor.lease).toBeUndefined();
    expect(service.db.prepare('SELECT status FROM leases WHERE id = ?').get(leaseId)).toEqual({ status: 'released' });
    const health = await request(service.app).get('/health');
    expect(health.body.pool.fee).toEqual({ free: 1, leased: 0 });
    await sponsor.release();
    expect(leaseStatuses()).toEqual(['released']);
  });

  it('gives the lease back when the service says the collateral it named was replaced, and builds on the current one next', async () => {
    await fundPool(2, 2);
    const stale = await shapeCreation(await sponsor.createTransactionBuilder()).build();
    const first = sponsor.lease?.leaseId;
    expect(sponsor.lease?.collateral.txHash).toBe(txHash(200));
    service.provider.removeUtxo({ txId: txHash(200), index: 0 });
    await service.sync.run();

    await expect(sponsor.signTransaction(stale, true)).rejects.toMatchObject({ status: 422, code: 'invalid_transaction', rule: 'uses_shared_collateral' });

    expect(sponsor.lease).toBeUndefined();
    expect(service.db.prepare('SELECT status FROM leases WHERE id = ?').get(first)).toEqual({ status: 'released' });
    const fresh = await shapeCreation(await sponsor.createTransactionBuilder()).build();
    expect(sponsor.lease?.leaseId).not.toBe(first);
    expect(sponsor.lease?.collateral.txHash).toBe(txHash(201));
    expect(parseTransaction(fresh).transaction?.collateralInputs).toEqual([{ txId: txHash(201), index: 0 }]);
    expect(await sponsor.signTransaction(fresh, true)).toHaveLength(1);
    expect(leaseStatuses()).toEqual(['released', 'consumed']);
  });

  it('replaces an expired lease with a new one, and drops a lease the service reports as gone', async () => {
    await fundPool(3, 1);
    await sponsor.createTransactionBuilder();
    const first = sponsor.lease?.leaseId;
    service.clock.now = new Date('2024-01-01T00:10:00.000Z');
    expect(sponsor.lease).toBeUndefined();

    await sponsor.getAddress();

    const second = sponsor.lease?.leaseId;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(leaseStatuses()).toEqual(['expired', 'open']);

    const transaction = await shapeCreation(await sponsor.createTransactionBuilder()).build();
    await request(service.app).delete(`/v1/leases/${second}`).set('Authorization', `Bearer ${apiKey}`);
    await expect(sponsor.signTransaction(transaction, true)).rejects.toMatchObject({ status: 410, code: 'lease_expired' });
    expect(sponsor.lease).toBeUndefined();
    await sponsor.getAddress();
    expect(sponsor.lease?.leaseId).not.toBe(second);
    expect(leaseStatuses()).toEqual(['expired', 'released', 'open']);
  });
});

describe('SponsorWallet in collateral mode', () => {
  it('takes no lease, offers the shared collateral and nothing to spend, and witnesses an operation the account pays for', async () => {
    await fundPool(0, 1);
    const owner = await ownerWallet();
    const ownerKey = await paymentKeyHashOf(owner);
    const { control, fund } = placeAccountOf(ownerKey);
    const sponsor = collateralSponsor();
    expect(sponsor.collateral).toBeUndefined();

    const [address, utxos, balance, held] = await Promise.all([sponsor.getAddress(), sponsor.getUnspentOutputs(), sponsor.getBalance(), sponsor.getCollateral()]);

    expect(address.toString()).toBe(service.serviceWallet.address);
    expect(utxos).toEqual([]);
    expect(balance).toEqual({ coins: 0n });
    expect(held).toEqual([sponsorUtxo({ txHash: txHash(200), index: 0, address: service.serviceWallet.address, lovelace: 5_000_000 })]);
    expect(sponsor.lease).toBeUndefined();
    expect(sponsor.collateral).toMatchObject({ txHash: txHash(200), validitySeconds: 600 });
    expect(leaseStatuses()).toEqual([]);

    const transaction = await buildAccountPaid(sponsor, ownerKey, control, fund);
    const parsed = parseTransaction(transaction).transaction;
    expect(parsed?.invalidHereafter).toBe(slotAt(service.config.slots, new Date('2024-01-01T00:09:00.000Z')));
    expect(parsed?.collateralInputs).toEqual([{ txId: txHash(200), index: 0 }]);
    expect(parsed?.outputs.every((output) => output.address === accountAddress)).toBe(true);

    const sponsorWitnesses = await sponsor.signTransaction(transaction, true);
    const ownerWitnesses = await owner.signTransaction(transaction, true);
    const signed = Cometa.applyVkeyWitnessSet(transaction, [...sponsorWitnesses, ...ownerWitnesses]);

    expect(sponsorWitnesses).toHaveLength(1);
    expect(signersOf(signed)).toEqual([service.serviceWallet.paymentKeyHash, ownerKey].sort());
    expect(leaseStatuses()).toEqual([]);
    expect(service.db.prepare('SELECT lease_id, sponsored_lovelace FROM witnesses WHERE tx_hash = ?').get(parsed?.hash)).toEqual({ lease_id: null, sponsored_lovelace: 0 });
    expect(await sponsor.signTransaction(transaction, true)).toEqual(sponsorWitnesses);
    expect((service.db.prepare("SELECT outcome FROM audit WHERE action = 'witness' ORDER BY id").all() as { outcome: string }[]).map((row) => row.outcome)).toEqual([
      'issued',
      'reissued',
    ]);
    expect(await sponsor.submitTransaction(signed)).toMatch(/^[0-9a-f]{64}$/);
    expect(service.provider.submitted).toEqual([signed]);
    expect(sponsor.collateral).toMatchObject({ txHash: txHash(200) });
  });

  it('drops the collateral it holds when the service says it was replaced, and builds on the current one next', async () => {
    await fundPool(0, 2);
    const owner = await ownerWallet();
    const ownerKey = await paymentKeyHashOf(owner);
    const { control, fund } = placeAccountOf(ownerKey);
    const sponsor = collateralSponsor();
    const stale = await buildAccountPaid(sponsor, ownerKey, control, fund);
    expect(sponsor.collateral?.txHash).toBe(txHash(200));
    service.provider.removeUtxo({ txId: txHash(200), index: 0 });
    await service.sync.run();

    await expect(sponsor.signTransaction(stale, true)).rejects.toMatchObject({ status: 422, code: 'invalid_transaction', rule: 'uses_shared_collateral' });

    expect(sponsor.collateral).toBeUndefined();
    const fresh = await buildAccountPaid(sponsor, ownerKey, control, fund);
    expect(sponsor.collateral?.txHash).toBe(txHash(201));
    expect(parseTransaction(fresh).transaction?.collateralInputs).toEqual([{ txId: txHash(201), index: 0 }]);
    expect(await sponsor.signTransaction(fresh, true)).toHaveLength(1);
  });

  it('surfaces a pool without collateral as a SponsorError, and release forgets the collateral it read', async () => {
    const sponsor = collateralSponsor();
    await expect(sponsor.getCollateral()).rejects.toMatchObject({ status: 503, code: 'out_of_funds' });

    await fundPool(0, 1);
    const reading = sponsor.getCollateral();
    await sponsor.release();
    expect(sponsor.collateral).toBeUndefined();
    expect(await reading).toHaveLength(1);

    await sponsor.getAddress();
    expect(sponsor.collateral?.txHash).toBe(txHash(200));
    await sponsor.release();
    expect(sponsor.collateral).toBeUndefined();
    expect(leaseStatuses()).toEqual([]);
  });
});
