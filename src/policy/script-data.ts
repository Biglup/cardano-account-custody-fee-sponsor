import type { PlutusLanguageVersion, ProtocolParameters } from '@biglup/cometa';
import { Cometa } from '../cometa.js';
import { plutusVersionName } from './parse.js';

/**
 * The redeemers and the datums a transaction's witness set carries, each
 * as the bytes they stand as in the transaction, which is what the
 * script data hash is taken over. A witness set that carries neither
 * leaves both undefined.
 */
export interface WitnessScriptData {
  redeemers: string | undefined;
  datums: string | undefined;
}

/** The length in bytes of a script data hash. */
const SCRIPT_DATA_HASH_BYTES = 32;

/** The witness set fields the script data hash commits to: the datums and the redeemers. */
const DATUMS_KEY = 4n;
const REDEEMERS_KEY = 5n;

/** The length a CBOR reader reports for an indefinite length array or map. */
const INDEFINITE_LENGTH = -1;

/** The empty map that stands in for the redeemers of a transaction carrying datums and no redeemers, which is how Conway represents redeemers. */
const EMPTY_REDEEMERS = 'a0';

/** The Plutus language a cost model of a provider's protocol parameters belongs to, by the name the parameters give it. */
const COST_MODEL_LANGUAGES: Record<string, PlutusLanguageVersion> = {
  PlutusV1: Cometa.PlutusLanguageVersion.V1,
  PlutusV2: Cometa.PlutusLanguageVersion.V2,
  PlutusV3: Cometa.PlutusLanguageVersion.V3,
};

/** A language and its cost model as the language view map holds them, each side already encoded. */
interface LanguageEntry {
  key: Uint8Array;
  value: Uint8Array;
}

/**
 * The redeemers and the datums of a transaction, read straight out of
 * its witness set rather than re-encoded, since the hash is taken over
 * the bytes the transaction carries and no other encoding of the same
 * values would hash to the same thing.
 */
export const witnessScriptData = (cbor: string): WitnessScriptData => {
  const transaction = Cometa.CborReader.fromHex(cbor);
  transaction.readStartArray();
  transaction.skipValue();
  const reader = Cometa.CborReader.fromHex(Cometa.uint8ArrayToHex(transaction.readEncodedValue()));
  const fields = reader.readStartMap();
  const data: WitnessScriptData = { redeemers: undefined, datums: undefined };
  let read = 0;
  while (fields === INDEFINITE_LENGTH ? reader.peekState() !== Cometa.CborReaderState.EndMap : read < fields) {
    const key = BigInt(reader.readUnsignedInt().toString());
    const value = Cometa.uint8ArrayToHex(reader.readEncodedValue());
    if (key === REDEEMERS_KEY) {
      data.redeemers = value;
    }
    if (key === DATUMS_KEY) {
      data.datums = value;
    }
    read += 1;
  }
  return data;
};

/** The cost model of a language in the provider's protocol parameters; a language the parameters price nothing for cannot be viewed. */
const costsOf = (language: PlutusLanguageVersion, parameters: ProtocolParameters): number[] => {
  const model = parameters.costModels.find((candidate) => COST_MODEL_LANGUAGES[candidate.language] === language);
  if (model === undefined) {
    throw new Error(`The protocol parameters hold no cost model for ${plutusVersionName(language)}`);
  }
  return model.costs;
};

/**
 * The view of one language: its tag and its cost model. Plutus V1 is
 * bagged twice, its tag encoded as a byte string holding the encoded tag
 * and its cost model as a byte string holding an indefinite length list,
 * which is how the ledger has encoded it since the language was
 * introduced; every later language takes the plain tag and a definite
 * length list.
 */
const languageEntry = (language: PlutusLanguageVersion, parameters: ProtocolParameters): LanguageEntry => {
  const costs = costsOf(language, parameters);
  if (language === Cometa.PlutusLanguageVersion.V1) {
    const list = new Cometa.CborWriter().startArray();
    for (const cost of costs) {
      list.writeInt(cost);
    }
    return {
      key: new Cometa.CborWriter().writeByteString(new Cometa.CborWriter().writeUnsignedInt(language).encode()).encode(),
      value: new Cometa.CborWriter().writeByteString(list.endArray().encode()).encode(),
    };
  }
  const list = new Cometa.CborWriter().startArray(costs.length);
  for (const cost of costs) {
    list.writeInt(cost);
  }
  return { key: new Cometa.CborWriter().writeUnsignedInt(language).encode(), value: list.encode() };
};

/** The order the language view map keeps its keys in: the shorter key first, and among keys of one length the lower one byte by byte. */
const compareKeys = (a: Uint8Array, b: Uint8Array): number => {
  if (a.length !== b.length) {
    return a.length - b.length;
  }
  for (let index = 0; index < a.length; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
};

/**
 * The language view of the languages a transaction's scripts are written
 * in: a map from each language to the cost model the network prices it
 * with, in the canonical order, which is what ties a script's budget to
 * the parameters it was evaluated under.
 */
const languageViews = (languages: PlutusLanguageVersion[], parameters: ProtocolParameters): Uint8Array => {
  const entries = [...new Set(languages)].map((language) => languageEntry(language, parameters)).sort((a, b) => compareKeys(a.key, b.key));
  const writer = new Cometa.CborWriter().startMap(entries.length);
  for (const entry of entries) {
    writer.writeEncoded(entry.key).writeEncoded(entry.value);
  }
  return writer.encode();
};

/**
 * The script integrity hash a transaction's witness set calls for: the
 * blake2b-256 digest of the redeemers, followed by the datums when it
 * carries any, followed by the language view of the languages its
 * scripts are written in. A witness set carrying datums and no redeemers
 * is hashed with an empty redeemer map in their place, and one carrying
 * neither calls for no hash at all.
 */
export const scriptIntegrityHash = (
  data: WitnessScriptData,
  languages: PlutusLanguageVersion[],
  parameters: ProtocolParameters,
): string | undefined => {
  if (data.redeemers === undefined && data.datums === undefined) {
    return undefined;
  }
  const views = Cometa.uint8ArrayToHex(languageViews(languages, parameters));
  const preimage = `${data.redeemers ?? EMPTY_REDEEMERS}${data.datums ?? ''}${views}`;
  return Cometa.uint8ArrayToHex(Cometa.Blake2b.computeHash(Cometa.hexToUint8Array(preimage), SCRIPT_DATA_HASH_BYTES));
};
