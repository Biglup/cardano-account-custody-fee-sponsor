/**
 * How a slot number maps to a time on one network: the slot the Shelley
 * era started at, the time of that slot in milliseconds since the Unix
 * epoch, and the length of every slot since, in milliseconds. Slots have
 * been one second long on every network since Shelley, and the service
 * assumes they stay so; a slot before the Shelley start never appears in
 * a transaction built today.
 */
export interface SlotSettings {
  zeroSlot: number;
  zeroTime: number;
  slotLengthMs: number;
}

/** The networks the service knows the slot timing of: preprod alone, which the configuration fixes. */
export type Network = 'preprod';

/** The length of a slot since Shelley, on every network. */
const SHELLEY_SLOT_LENGTH_MS = 1000;

/** The Shelley start of each network: preprod on 2022-06-21. */
export const SLOT_SETTINGS_BY_NETWORK: Record<Network, SlotSettings> = {
  preprod: { zeroSlot: 86_400, zeroTime: Date.UTC(2022, 5, 21), slotLengthMs: SHELLEY_SLOT_LENGTH_MS },
};

/** The time a slot starts at. */
export const slotToTime = (slots: SlotSettings, slot: bigint): Date =>
  new Date(Number(BigInt(slots.zeroTime) + (slot - BigInt(slots.zeroSlot)) * BigInt(slots.slotLengthMs)));

/** The slot a time falls in. */
export const slotAt = (slots: SlotSettings, time: Date): bigint =>
  BigInt(slots.zeroSlot) + (BigInt(time.getTime()) - BigInt(slots.zeroTime)) / BigInt(slots.slotLengthMs);
