import { createHash } from 'node:crypto';
import type { CborReader, TxIn, TxOut } from '@biglup/cometa';
import { Cometa } from '../../src/cometa.js';

/** The inputs, outputs and fee of a transaction, read back from its CBOR. */
export interface TransactionParts {
  inputs: TxIn[];
  outputs: TxOut[];
  fee: bigint;
}

/** The keys of the transaction body fields read back. */
const BODY_INPUTS = 0n;
const BODY_OUTPUTS = 1n;
const BODY_FEE = 2n;

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

/** The inputs, outputs and fee of a transaction CBOR. */
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
          parts.inputs = readInputs(reader);
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

/** A stand-in transaction id for the fake chain: 32 bytes derived from the CBOR, so it is stable and unique per transaction. */
export const fakeTransactionId = (txCbor: string): string => createHash('sha256').update(txCbor, 'utf8').digest('hex');
