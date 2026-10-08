import { DataB } from '@harmoniclabs/plutus-data';
import { Application, UPLCConst, UPLCProgram, compileUPLC, parseUPLC } from '@harmoniclabs/uplc';
import { Cometa } from '../cometa.js';

/** The stake script hash of the account a device key owns, which is the stake credential a creation by that device registers. */
export type StakeScriptHashOf = (device: string) => string;

/** How many derivations are kept at once, so that a stream of device keys never seen before cannot grow the memory without end. */
export const MAX_CACHED_DERIVATIONS = 4096;

/** The flat encoded program a blueprint's compiled code wraps in a CBOR byte string. */
const unwrapCompiledCode = (compiledCode: string): Uint8Array => Cometa.CborReader.fromHex(compiledCode).readByteString();

/** A flat encoded program wrapped in a CBOR byte string, as a blueprint carries it. */
const wrapCompiledCode = (program: Uint8Array): string => Cometa.uint8ArrayToHex(new Cometa.CborWriter().writeByteString(program).encode());

/**
 * Applies parameters to the compiled code of a parameterised validator
 * the way the Aiken CLI and the contract's own library do: the program's
 * body is applied to each parameter in turn, every parameter given as a
 * Plutus data constant holding its bytes, and the program is encoded
 * again. The result is the compiled code of the validator with those
 * parameters fixed, byte for byte what the Aiken CLI produces.
 */
export const applyParameters = (compiledCode: string, parameters: Uint8Array[]): string => {
  const program = parseUPLC(unwrapCompiledCode(compiledCode), 'flat');
  const body = parameters.reduce((applied, parameter) => new Application(applied, UPLCConst.data(new DataB(parameter))), program.body);
  return wrapCompiledCode(compileUPLC(new UPLCProgram(program.version, body)));
};

/**
 * The derivation of an account's stake script hash from the device key
 * that owns it: the account stake validator applied to that key as the
 * owner and to the account script hash, hashed as the Plutus V3 script
 * it is. That hash is the account's stake credential and the name of
 * its state NFT, so it is what a creation by that device registers.
 * Each derivation parses and encodes the validator again, so the hash
 * is kept per device key, up to `capacity` of them, the oldest forgotten
 * once the cache is full.
 */
export const createStakeScriptDerivation = (compiledCode: string, accountScriptHash: string, capacity = MAX_CACHED_DERIVATIONS): StakeScriptHashOf => {
  const hashes = new Map<string, string>();
  return (device) => {
    const cached = hashes.get(device);
    if (cached !== undefined) {
      return cached;
    }
    const applied = applyParameters(compiledCode, [Cometa.hexToUint8Array(device), Cometa.hexToUint8Array(accountScriptHash)]);
    const hash = Cometa.computeScriptHash({ type: Cometa.ScriptType.Plutus, bytes: applied, version: Cometa.PlutusLanguageVersion.V3 });
    const oldest = hashes.keys().next().value;
    if (hashes.size >= capacity && oldest !== undefined) {
      hashes.delete(oldest);
    }
    hashes.set(device, hash);
    return hash;
  };
};
