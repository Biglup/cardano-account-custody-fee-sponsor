import { describe, expect, it } from 'vitest';
import { Cometa } from '../src/cometa.js';
import { SLOT_SETTINGS_BY_NETWORK, slotAt, slotToTime } from '../src/slots.js';

describe('slot settings', () => {
  it('match the Shelley start of preprod as cometa knows it, and know no other network', () => {
    const { preprod } = SLOT_SETTINGS_BY_NETWORK;

    expect(preprod).toEqual({
      zeroSlot: Number(Cometa.CARDANO_PREPROD_SLOT_CONFIG.zeroSlot),
      zeroTime: Number(Cometa.CARDANO_PREPROD_SLOT_CONFIG.zeroTime),
      slotLengthMs: Number(Cometa.CARDANO_PREPROD_SLOT_CONFIG.slotLength),
    });
    expect(Object.keys(SLOT_SETTINGS_BY_NETWORK)).toEqual(['preprod']);
  });

  it('converts a slot to the time it starts at and back', () => {
    const preprod = SLOT_SETTINGS_BY_NETWORK.preprod;

    expect(slotToTime(preprod, 86_400n).toISOString()).toBe('2022-06-21T00:00:00.000Z');
    expect(slotToTime(preprod, 48_384_600n).toISOString()).toBe('2024-01-01T00:10:00.000Z');
    expect(slotAt(preprod, new Date('2024-01-01T00:10:00.000Z'))).toBe(48_384_600n);
    expect(slotAt(preprod, new Date('2024-01-01T00:10:00.999Z'))).toBe(48_384_600n);
  });
});
