import { createHash } from 'node:crypto';
import type { CborReader, PlutusScript, TxIn, TxOut } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';

/** The inputs, outputs and fee of a transaction, read back from its CBOR. */
export interface TransactionParts {
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
}

/** The keys of the transaction body fields read back or rewritten. */
const BODY_INPUTS = 0n;
const BODY_OUTPUTS = 1n;
const BODY_FEE = 2n;
const BODY_CERTIFICATES = 4n;
const BODY_COLLATERAL_RETURN = 16n;
const BODY_TOTAL_COLLATERAL = 17n;
const BODY_PROPOSAL_PROCEDURES = 20n;

/** The keys of a post Alonzo output map and the CBOR tag wrapping an encoded script. */
const OUTPUT_ADDRESS = 0;
const OUTPUT_VALUE = 1;
const OUTPUT_DATUM = 2;
const OUTPUT_SCRIPT_REF = 3;
const ENCODED_CBOR_TAG = 24;

/** The kinds of the certificates the tests craft and the Plutus language of a reference script, as the ledger numbers them. */
const POOL_REGISTRATION = 3;
const AUTH_COMMITTEE_HOT = 14;
const UPDATE_DREP = 18;
const PLUTUS_V3 = 3;
const UNIT_INTERVAL_TAG = 30;

/** The kind of the governance action that carries nothing but an anchor. */
const INFO_ACTION = 6;

/** Lexicographic order of hex strings, which is the byte order of what they encode. */
const compareHex = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The order the ledger keeps inputs in, which redeemer indexes refer to: by transaction id, then by index. */
export const compareInputs = (a: TxIn, b: TxIn): number => compareHex(a.txId, b.txId) || a.index - b.index;

/** Reads every item of a definite or indefinite length array or map. */
const readItems = <T>(reader: CborReader, readItem: () => T, { map = false }: { map?: boolean } = {}): T[] => {
  const indefinite = -1;
  const length = map ? reader.readStartMap() : reader.readStartArray();
  const items: T[] = [];
  const endState = map ? Cometa.CborReaderState.EndMap : Cometa.CborReaderState.EndArray;
  while (length === indefinite ? reader.peekState() !== endState : items.length < length) {
    items.push(readItem());
  }
  if (map) {
    reader.readEndMap();
  } else {
    reader.readEndArray();
  }
  return items;
};

/** Reads one input: a transaction id and an output index. */
const readInput = (reader: CborReader): TxIn => {
  const [txId, index] = readItems(reader, () =>
    reader.peekState() === Cometa.CborReaderState.ByteString
      ? Cometa.uint8ArrayToHex(reader.readByteString())
      : Number(reader.readUnsignedInt()),
  );
  return { txId: txId as string, index: index as number };
};

/** Reads the input set, which may be tagged as a set. */
const readInputs = (reader: CborReader): TxIn[] => {
  if (reader.peekState() === Cometa.CborReaderState.Tag) {
    reader.readTag();
  }
  return readItems(reader, () => readInput(reader));
};

/** The inputs, outputs and fee of a transaction CBOR, with the inputs in the order the ledger presents them. */
export const transactionParts = (txCbor: string): TransactionParts => {
  const reader = Cometa.CborReader.fromHex(txCbor);
  reader.readStartArray();
  const parts: TransactionParts = { inputs: [], outputs: [], fee: 0n };
  readItems(
    reader,
    () => {
      const key = BigInt(reader.readUnsignedInt().toString());
      switch (key) {
        case BODY_INPUTS:
          parts.inputs = readInputs(reader).sort(compareInputs);
          break;
        case BODY_OUTPUTS:
          parts.outputs = readItems(reader, () => Cometa.readTxOutFromCbor(Cometa.uint8ArrayToHex(reader.readEncodedValue())));
          break;
        case BODY_FEE:
          parts.fee = BigInt(reader.readUnsignedInt().toString());
          break;
        default:
          reader.skipValue();
      }
    },
    { map: true },
  );
  return parts;
};

/** The number of items of a Conway transaction: the body, the witness set, the phase two flag and the auxiliary data. */
const TRANSACTION_ITEMS = 4;

/** The four items of a transaction, each still encoded. */
interface TransactionItems {
  body: Uint8Array;
  witnessSet: Uint8Array;
  isValid: boolean;
  auxiliaryData: Uint8Array;
}

const readTransaction = (txCbor: string): TransactionItems => {
  const reader = Cometa.CborReader.fromHex(txCbor);
  reader.readStartArray();
  return { body: reader.readEncodedValue(), witnessSet: reader.readEncodedValue(), isValid: reader.readBoolean(), auxiliaryData: reader.readEncodedValue() };
};

const writeTransaction = (items: TransactionItems): string =>
  new Cometa.CborWriter()
    .startArray(TRANSACTION_ITEMS)
    .writeEncoded(items.body)
    .writeEncoded(items.witnessSet)
    .writeBoolean(items.isValid)
    .writeEncoded(items.auxiliaryData)
    .encodeHex();

/**
 * The same transaction with its phase two flag cleared, as a client
 * declares a transaction whose scripts are expected to fail and whose
 * collateral the ledger should take.
 */
export const markInvalid = (txCbor: string): string => writeTransaction({ ...readTransaction(txCbor), isValid: false });

const bytes = (hex: string): Uint8Array => Cometa.hexToUint8Array(hex);

/** The entries of a transaction body, each value still encoded. */
interface BodyEntry {
  key: bigint;
  value: Uint8Array;
}

const readBodyEntries = (body: Uint8Array): BodyEntry[] => {
  const reader = Cometa.CborReader.fromHex(Cometa.uint8ArrayToHex(body));
  return readItems(reader, () => ({ key: BigInt(reader.readUnsignedInt().toString()), value: reader.readEncodedValue() }), { map: true });
};

/**
 * The same transaction with one body field set to an encoded value, in
 * place of what was there, as a client editing the body by hand would
 * produce. The witness set is kept as it is, so the transaction is as
 * much a transaction as before for everything the policy reads.
 */
export const withBodyField = (txCbor: string, key: bigint, valueCbor: string): string => {
  const items = readTransaction(txCbor);
  const entries = [...readBodyEntries(items.body).filter((entry) => entry.key !== key), { key, value: bytes(valueCbor) }].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : 0,
  );
  const writer = new Cometa.CborWriter().startMap(entries.length);
  for (const entry of entries) {
    writer.writeUnsignedInt(entry.key).writeEncoded(entry.value);
  }
  return writeTransaction({ ...items, body: bytes(writer.encodeHex()) });
};

/** The same transaction declaring `lovelace` as its total collateral. */
export const withTotalCollateral = (txCbor: string, lovelace: bigint): string =>
  withBodyField(txCbor, BODY_TOTAL_COLLATERAL, new Cometa.CborWriter().writeUnsignedInt(lovelace).encodeHex());

/** The same transaction with the given encoded certificates as its certificate list. */
export const withCertificates = (txCbor: string, certificates: string[]): string => {
  const writer = new Cometa.CborWriter().startArray(certificates.length);
  for (const certificate of certificates) {
    writer.writeEncoded(bytes(certificate));
  }
  return withBodyField(txCbor, BODY_CERTIFICATES, writer.encodeHex());
};

/**
 * The same transaction proposing an informational governance action
 * with no deposit, refunded to the testnet reward account of `keyHash`,
 * as the simplest proposal procedure a body can carry.
 */
export const withInfoProposal = (txCbor: string, keyHash: string): string => {
  const procedures = new Cometa.CborWriter()
    .startArray(1)
    .startArray(4)
    .writeUnsignedInt(0)
    .writeByteString(bytes(`e0${keyHash}`))
    .startArray(1)
    .writeUnsignedInt(INFO_ACTION)
    .startArray(2)
    .writeTextString('https://example.invalid/info')
    .writeByteString(bytes('00'.repeat(32)))
    .encodeHex();
  return withBodyField(txCbor, BODY_PROPOSAL_PROCEDURES, procedures);
};

/** The same transaction with the given encoded output as its collateral return. */
export const withCollateralReturn = (txCbor: string, outputCbor: string): string => withBodyField(txCbor, BODY_COLLATERAL_RETURN, outputCbor);

/** The same transaction with the given encoded output appended to its outputs; nothing rebalances it. */
export const withExtraOutput = (txCbor: string, outputCbor: string): string => {
  const entry = readBodyEntries(readTransaction(txCbor).body).find((candidate) => candidate.key === BODY_OUTPUTS);
  const reader = Cometa.CborReader.fromHex(Cometa.uint8ArrayToHex(entry?.value ?? new Uint8Array()));
  const outputs = readItems(reader, () => reader.readEncodedValue());
  const writer = new Cometa.CborWriter().startArray(outputs.length + 1);
  for (const output of outputs) {
    writer.writeEncoded(output);
  }
  writer.writeEncoded(bytes(outputCbor));
  return withBodyField(txCbor, BODY_OUTPUTS, writer.encodeHex());
};

/** A lovelace only output as a post Alonzo map, so that it can carry a datum hash or a reference script. */
const outputMap = (address: string, lovelace: bigint, extra: (writer: InstanceType<typeof Cometa.CborWriter>) => void, extraEntries: number): string => {
  const writer = new Cometa.CborWriter().startMap(2 + extraEntries);
  writer.writeUnsignedInt(OUTPUT_ADDRESS).writeByteString(Cometa.Address.fromString(address).toBytes());
  writer.writeUnsignedInt(OUTPUT_VALUE).writeUnsignedInt(lovelace);
  extra(writer);
  return writer.encodeHex();
};

/** An output paying `lovelace` to `address` with a datum hash attached. */
export const outputWithDatumHash = (address: string, lovelace: bigint, datumHash: string): string =>
  outputMap(address, lovelace, (writer) => writer.writeUnsignedInt(OUTPUT_DATUM).startArray(2).writeUnsignedInt(0).writeByteString(bytes(datumHash)), 1);

/** An output paying `lovelace` to `address` with a Plutus V3 script attached as a reference script. */
export const outputWithReferenceScript = (address: string, lovelace: bigint, script: PlutusScript): string => {
  const encoded = new Cometa.CborWriter().startArray(2).writeUnsignedInt(PLUTUS_V3).writeByteString(bytes(script.bytes)).encodeHex();
  return outputMap(address, lovelace, (writer) => writer.writeUnsignedInt(OUTPUT_SCRIPT_REF).writeTag(ENCODED_CBOR_TAG).writeByteString(bytes(encoded)), 1);
};

/** A key hash credential as certificates carry it. */
const keyCredentialCbor = (keyHash: string): string => new Cometa.CborWriter().startArray(2).writeUnsignedInt(0).writeByteString(bytes(keyHash)).encodeHex();

/** A DRep update certificate for the DRep whose key hash is given, with no anchor. */
export const updateDRepCertificate = (keyHash: string): string =>
  new Cometa.CborWriter().startArray(3).writeUnsignedInt(UPDATE_DREP).writeEncoded(bytes(keyCredentialCbor(keyHash))).writeNull().encodeHex();

/** A committee hot key authorisation by the cold key whose hash is given. */
export const authCommitteeHotCertificate = (coldKeyHash: string, hotKeyHash: string): string =>
  new Cometa.CborWriter()
    .startArray(3)
    .writeUnsignedInt(AUTH_COMMITTEE_HOT)
    .writeEncoded(bytes(keyCredentialCbor(coldKeyHash)))
    .writeEncoded(bytes(keyCredentialCbor(hotKeyHash)))
    .encodeHex();

/** A pool registration naming the given operator, testnet reward account key and owners, with no pledge, relays or metadata. */
export const poolRegistrationCertificate = (operatorKeyHash: string, rewardKeyHash: string, owners: string[]): string => {
  const writer = new Cometa.CborWriter()
    .startArray(10)
    .writeUnsignedInt(POOL_REGISTRATION)
    .writeByteString(bytes(operatorKeyHash))
    .writeByteString(bytes('11'.repeat(32)))
    .writeUnsignedInt(0)
    .writeUnsignedInt(170_000_000)
    .writeTag(UNIT_INTERVAL_TAG)
    .startArray(2)
    .writeUnsignedInt(0)
    .writeUnsignedInt(1)
    .writeByteString(bytes(`e0${rewardKeyHash}`))
    .startArray(owners.length);
  for (const owner of owners) {
    writer.writeByteString(bytes(owner));
  }
  return writer.startArray(0).writeNull().encodeHex();
};

/** A stand-in transaction id for the fake chain: 32 bytes derived from the CBOR, so it is stable and unique per transaction. */
export const fakeTransactionId = (txCbor: string): string => createHash('sha256').update(txCbor, 'utf8').digest('hex');
