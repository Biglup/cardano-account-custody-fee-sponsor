import { randomBytes } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import request from 'supertest';
import type { Wallet } from '@biglup/cometa';
import { SponsorError, SponsorWallet } from '../../src/client/sponsor-wallet.js';
import { Cometa } from '../../src/cometa.js';
import { parseTransaction } from '../../src/policy/parse.js';
import { slotAt } from '../../src/slots.js';
import { strangerAddress } from '../support/account.js';
import { leasedUtxo, shapeCreation } from '../support/client.js';
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
    expect(await sponsor.getUnspentOutputs()).toEqual([leasedUtxo(lease?.fee ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    expect(await sponsor.getCollateral()).toEqual([leasedUtxo(lease?.collateral ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
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
    expect(utxos).toEqual([leasedUtxo(lease?.fee ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
    expect(collateral).toEqual([leasedUtxo(lease?.collateral ?? { txHash: '', index: 0, address: '', lovelace: 0 })]);
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

    const vkeyWitnesses = Cometa.inspectTx(signed).witness_set.vkey_witnesses as { vkey: string }[];
    expect(vkeyWitnesses.map((witness) => keyHashOf(witness.vkey)).sort()).toEqual([service.serviceWallet.paymentKeyHash, ownerKey].sort());
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
