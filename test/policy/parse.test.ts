import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { Credential } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';
import type { LeaseBody } from '../../src/http/leases.js';
import { MAX_TRANSACTION_BYTES, parseTransaction, paymentCredentialOf, plutusLanguageOf, resolveInputs } from '../../src/policy/parse.js';
import {
  DEVICE_KEY,
  STRANGER_KEY,
  accountAddress,
  accountScriptHash,
  byronAddress,
  controlUtxo,
  enterpriseAddress,
  pointerAddress,
  stakeScriptHash,
  stateNftAssetId,
} from '../support/account.js';
import { buildCreation, buildOwnerOperation } from '../support/client.js';
import { type TestService, createTestService, txHash } from '../support/service.js';
import { poolRegistrationCertificate, transactionParts, withCertificates, withInfoProposal } from '../support/transaction.js';

let service: TestService;
let lease: LeaseBody;

beforeEach(async () => {
  service = await createTestService();
  service.fund(txHash(100), 0, 100_000_000n);
  service.fund(txHash(200), 0, 5_000_000n);
  await service.sync.run();
  const { apiKey } = service.issueKey();
  const response = await request(service.app).post('/v1/leases').set({ Authorization: `Bearer ${apiKey}` });
  lease = response.body as LeaseBody;
});

afterEach(() => {
  service.close();
});

describe('parseTransaction', () => {
  it('reads every part of an account creation the policy needs', async () => {
    const cbor = await buildCreation(service, lease);
    const parts = transactionParts(cbor);

    const parsed = parseTransaction(cbor).transaction;

    expect(parsed).toBeDefined();
    expect(parsed?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(parsed?.size).toBe(cbor.length / 2);
    expect(parsed?.inputs).toEqual(parts.inputs);
    expect(parsed?.fee).toBe(parts.fee);
    expect(parsed?.outputs.map((output) => [output.address, output.lovelace, output.hasDatum, output.hasReferenceScript])).toEqual(
      parts.outputs.map((output) => [output.address, output.value.coins, output.datum !== undefined, false]),
    );
    expect(parsed?.mint).toEqual({ [stateNftAssetId]: 1n });
    const registered = { hash: stakeScriptHash, type: Cometa.CredentialType.ScriptHash };
    expect(parsed?.certificates).toEqual([{ kind: 'registration', credential: registered, credentials: [registered], deposit: 2_000_000n }]);
    expect(parsed?.voters).toEqual([]);
    expect(parsed?.collateralInputs).toEqual([{ txId: lease.collateral.txHash, index: lease.collateral.index }]);
    expect(parsed?.collateralReturn?.address).toBe(lease.sponsorAddress);
    expect(parsed?.totalCollateral).toBeGreaterThan(0n);
    expect(parsed?.requiredSigners).toEqual([DEVICE_KEY]);
    expect(parsed?.scripts.map((script) => script.hash).sort()).toEqual([accountScriptHash, stakeScriptHash].sort());
    expect(parsed?.redeemers.map((redeemer) => redeemer.purpose).sort()).toEqual([Cometa.RedeemerPurpose.certificate, Cometa.RedeemerPurpose.mint]);
    expect(Object.fromEntries(parsed?.redeemers.map((redeemer) => [redeemer.purpose, redeemer.executionUnits]) ?? [])).toEqual({
      certificate: { memory: 900_000n, steps: 350_000_000n },
      mint: { memory: 1_200_000n, steps: 480_000_000n },
    });
    const control = parsed?.outputs.find((output) => output.address === accountAddress);
    expect(control?.paymentCredential).toEqual({ hash: accountScriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(control?.stakeCredential).toEqual({ hash: stakeScriptHash, type: Cometa.CredentialType.ScriptHash });
  });

  it('reads every credential a certificate names and every voter, whatever kind they are', async () => {
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const operator = '11'.repeat(28);
    const owner = '22'.repeat(28);
    const voter = { hash: '33'.repeat(28), type: Cometa.CredentialType.KeyHash };
    const cbor = withCertificates(
      await buildOwnerOperation(service, lease, control, {
        customise: (builder) =>
          builder.vote({
            voter: { type: Cometa.VoterType.DRepKeyHash, credential: voter },
            actionId: { id: txHash(900), actionIndex: 0 },
            votingProcedure: { vote: Cometa.Vote.Yes, anchor: null },
          }),
      }),
      [poolRegistrationCertificate(operator, STRANGER_KEY, [owner])],
    );

    const parsed = parseTransaction(cbor).transaction;

    const key = (hash: string): Credential => ({ hash, type: Cometa.CredentialType.KeyHash });
    expect(parsed?.certificates).toEqual([
      { kind: 'pool_registration', credential: undefined, credentials: [key(operator), key(STRANGER_KEY), key(owner)], deposit: undefined },
    ]);
    expect(parsed?.voters).toEqual([{ kind: 'drep_credential', credential: voter }]);
  });

  it('hashes the body as the ledger does, so the same transaction has the same hash whatever its witnesses', async () => {
    const cbor = await buildCreation(service, lease);
    const witnesses = await service.serviceWallet.wallet.signTransaction(cbor, true);
    const signed = Cometa.applyVkeyWitnessSet(cbor, witnesses);
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const other = await buildOwnerOperation(service, lease, control);

    expect(parseTransaction(signed).transaction?.hash).toBe(parseTransaction(cbor).transaction?.hash);
    expect(parseTransaction(other).transaction?.hash).not.toBe(parseTransaction(cbor).transaction?.hash);
  });

  it('refuses what is not hex, what does not decode and what is too large as not well formed', () => {
    expect(parseTransaction('xyz').violation).toEqual({ rule: 'well_formed', detail: expect.stringMatching(/not a hex encoded/) });
    expect(parseTransaction('a0').violation).toEqual({ rule: 'well_formed', detail: expect.stringMatching(/does not decode/) });
    expect(parseTransaction('00'.repeat(MAX_TRANSACTION_BYTES + 1)).violation).toEqual({
      rule: 'well_formed',
      detail: expect.stringMatching(/over the 16384 byte limit/),
    });
  });

  it('refuses proposal procedures and a treasury donation as not well formed, since no account transaction carries them', async () => {
    const plain = await buildCreation(service, lease);
    const neither = /account transactions carry neither proposal procedures nor a treasury donation/;

    expect(parseTransaction(withInfoProposal(plain, STRANGER_KEY)).violation).toEqual({
      rule: 'well_formed',
      detail: expect.stringMatching(/carries proposal procedures; .*/.source + neither.source),
    });
    const donating = await buildCreation(service, lease, { customise: (builder) => builder.setDonation(1_000_000n) });
    expect(parseTransaction(donating).violation).toEqual({
      rule: 'well_formed',
      detail: expect.stringMatching(/carries a treasury donation; .*/.source + neither.source),
    });
  });
});

describe('plutusLanguageOf', () => {
  it('maps every language the view can label and refuses any other, so no script is ever hashed under a guessed language', () => {
    expect(plutusLanguageOf('plutus_v1')).toBe(Cometa.PlutusLanguageVersion.V1);
    expect(plutusLanguageOf('plutus_v2')).toBe(Cometa.PlutusLanguageVersion.V2);
    expect(plutusLanguageOf('plutus_v3')).toBe(Cometa.PlutusLanguageVersion.V3);
    expect(() => plutusLanguageOf('plutus_v4')).toThrow('A script witness carries the unknown Plutus language plutus_v4');
  });
});

describe('paymentCredentialOf', () => {
  it('reads the payment credential of base, enterprise and pointer addresses and nothing from a Byron address', () => {
    const key = { hash: STRANGER_KEY, type: Cometa.CredentialType.KeyHash };

    expect(paymentCredentialOf(accountAddress)).toEqual({ hash: accountScriptHash, type: Cometa.CredentialType.ScriptHash });
    expect(paymentCredentialOf(enterpriseAddress(STRANGER_KEY))).toEqual(key);
    expect(paymentCredentialOf(pointerAddress(STRANGER_KEY))).toEqual(key);
    expect(paymentCredentialOf(byronAddress)).toBeUndefined();
  });
});

describe('resolveInputs', () => {
  it('pairs each input with the output it spends and leaves unknown inputs unresolved', async () => {
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    const unknown = { txId: txHash(999), index: 3 };

    const resolved = (await resolveInputs(service.provider, [control.input, unknown])).inputs;

    expect(resolved).toHaveLength(2);
    expect(resolved?.[0]?.ref).toBe(`${txHash(300)}#0`);
    expect(resolved?.[0]?.output?.lovelace).toBe(2_000_000n);
    expect(resolved?.[0]?.output?.assets).toEqual({ [stateNftAssetId]: 1n });
    expect(resolved?.[0]?.output?.hasDatum).toBe(true);
    expect(resolved?.[1]).toEqual({ input: unknown, ref: `${txHash(999)}#3`, output: undefined });
  });

  it('refuses at evaluation when the provider rejects the lookup, without asking again input by input', async () => {
    const control = controlUtxo(txHash(300));
    service.provider.addUtxo(control);
    service.provider.setResolutionFailure('Transaction not found');

    const resolved = await resolveInputs(service.provider, [control.input, { txId: txHash(999), index: 3 }]);

    expect(resolved).toEqual({ violation: { rule: 'evaluates', detail: 'The inputs could not be resolved: Transaction not found' } });
  });
});
