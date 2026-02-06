import { describe, expect, it } from "vitest";
import {
  beginReload,
  createWeaponState,
  isReloading,
  tickReload,
  tryFireWeapon,
  WEAPONS,
} from "./weapons";

describe("weapon firing", () => {
  it("fires and consumes ammo", () => {
    const initial = createWeaponState("assaultRifle");
    const fired = tryFireWeapon(initial, 1_000);

    expect(fired.didFire).toBe(true);
    expect(fired.next.ammoInMag).toBe(initial.ammoInMag - 1);
  });

  it("respects fire interval cooldown", () => {
    const initial = createWeaponState("pistol");
    const first = tryFireWeapon(initial, 1_000);
    const second = tryFireWeapon(first.next, 1_001);

    expect(first.didFire).toBe(true);
    expect(second.didFire).toBe(false);
    expect(second.reason).toBe("cooldown");
  });
});

describe("weapon reload", () => {
  it("refills magazine after reload duration", () => {
    const spec = WEAPONS.shotgun;
    const initial = {
      ...createWeaponState("shotgun"),
      ammoInMag: 1,
      ammoReserve: 20,
    };

    const started = beginReload(initial, 5_000);

    expect(isReloading(started, 5_050)).toBe(true);

    const complete = tickReload(started, 5_000 + spec.reloadMs + 1);

    expect(complete.ammoInMag).toBe(spec.magSize);
    expect(complete.ammoReserve).toBeLessThan(20);
    expect(complete.reloadingUntil).toBeNull();
  });

  it("does not reload when magazine is already full", () => {
    const initial = createWeaponState("pistol");
    const started = beginReload(initial, 1_000);

    expect(started).toBe(initial);
  });
});
