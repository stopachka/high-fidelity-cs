import type { WeaponId, WeaponRuntimeState, WeaponSpec } from "./types";

export const WEAPON_ORDER: WeaponId[] = ["assaultRifle", "shotgun", "pistol"];

export const WEAPONS: Record<WeaponId, WeaponSpec> = {
  assaultRifle: {
    id: "assaultRifle",
    label: "AR-44 Viper",
    modelPath: "/assets/models/weapons/assault-rifle.glb",
    fireIntervalMs: 95,
    reloadMs: 2100,
    magSize: 30,
    reserveAmmo: 120,
    pellets: 1,
    spread: 0.011,
    baseDamage: 27,
    falloffPerMeter: 0.012,
    armorPenetration: 0.64,
    headshotMultiplier: 3.8,
    automatic: true,
    recoilPitch: 0.0028,
    recoilYaw: 0.0019,
    muzzleFlashIntensity: 2.2,
  },
  shotgun: {
    id: "shotgun",
    label: "SG-12 Mauler",
    modelPath: "/assets/models/weapons/shotgun.glb",
    fireIntervalMs: 820,
    reloadMs: 2700,
    magSize: 8,
    reserveAmmo: 40,
    pellets: 8,
    spread: 0.055,
    baseDamage: 12,
    falloffPerMeter: 0.048,
    armorPenetration: 0.42,
    headshotMultiplier: 1.8,
    automatic: false,
    recoilPitch: 0.011,
    recoilYaw: 0.006,
    muzzleFlashIntensity: 2.8,
  },
  pistol: {
    id: "pistol",
    label: "PX-9 Phantom",
    modelPath: "/assets/models/weapons/pistol.glb",
    fireIntervalMs: 210,
    reloadMs: 1600,
    magSize: 15,
    reserveAmmo: 60,
    pellets: 1,
    spread: 0.008,
    baseDamage: 31,
    falloffPerMeter: 0.018,
    armorPenetration: 0.57,
    headshotMultiplier: 2.9,
    automatic: false,
    recoilPitch: 0.005,
    recoilYaw: 0.0025,
    muzzleFlashIntensity: 1.8,
  },
};

export type FireResultReason =
  | "fired"
  | "cooldown"
  | "reloading"
  | "empty-mag";

export interface FireResult {
  next: WeaponRuntimeState;
  didFire: boolean;
  reason: FireResultReason;
}

export function createWeaponState(weaponId: WeaponId): WeaponRuntimeState {
  const spec = WEAPONS[weaponId];

  return {
    weaponId,
    ammoInMag: spec.magSize,
    ammoReserve: spec.reserveAmmo,
    lastShotAt: -Number.MAX_SAFE_INTEGER,
    reloadingUntil: null,
  };
}

export function createInitialWeaponStates(): Record<WeaponId, WeaponRuntimeState> {
  return {
    assaultRifle: createWeaponState("assaultRifle"),
    shotgun: createWeaponState("shotgun"),
    pistol: createWeaponState("pistol"),
  };
}

export function tryFireWeapon(
  state: WeaponRuntimeState,
  now: number,
): FireResult {
  const spec = WEAPONS[state.weaponId];

  if (state.reloadingUntil !== null && now < state.reloadingUntil) {
    return { next: state, didFire: false, reason: "reloading" };
  }

  if (now - state.lastShotAt < spec.fireIntervalMs) {
    return { next: state, didFire: false, reason: "cooldown" };
  }

  if (state.ammoInMag <= 0) {
    return { next: state, didFire: false, reason: "empty-mag" };
  }

  return {
    next: {
      ...state,
      ammoInMag: state.ammoInMag - 1,
      lastShotAt: now,
    },
    didFire: true,
    reason: "fired",
  };
}

export function beginReload(
  state: WeaponRuntimeState,
  now: number,
): WeaponRuntimeState {
  const spec = WEAPONS[state.weaponId];

  if (state.reloadingUntil !== null) {
    return state;
  }

  if (state.ammoInMag >= spec.magSize || state.ammoReserve <= 0) {
    return state;
  }

  return {
    ...state,
    reloadingUntil: now + spec.reloadMs,
  };
}

export function tickReload(
  state: WeaponRuntimeState,
  now: number,
): WeaponRuntimeState {
  const spec = WEAPONS[state.weaponId];

  if (state.reloadingUntil === null || now < state.reloadingUntil) {
    return state;
  }

  const missing = spec.magSize - state.ammoInMag;
  const refill = Math.min(missing, state.ammoReserve);

  return {
    ...state,
    ammoInMag: state.ammoInMag + refill,
    ammoReserve: state.ammoReserve - refill,
    reloadingUntil: null,
  };
}

export function isReloading(state: WeaponRuntimeState, now: number): boolean {
  return state.reloadingUntil !== null && now < state.reloadingUntil;
}
