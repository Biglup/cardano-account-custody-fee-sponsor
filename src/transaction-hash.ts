import { Cometa } from './cometa.js';

/** The length in bytes of a transaction hash. */
const TRANSACTION_HASH_BYTES = 32;

/** The hash of a transaction, which is the hash of its body's CBOR bytes as they stand in the transaction. */
export const transactionHash = (cbor: string): string => {
  const reader = Cometa.CborReader.fromHex(cbor);
  reader.readStartArray();
  return Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(reader.readEncodedValue(), TRANSACTION_HASH_BYTES));
};
