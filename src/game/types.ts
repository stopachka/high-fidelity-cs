import type { InstaQLEntity, PresencePeer } from "@instantdb/core";
import type { AppSchema } from "../instant.schema";

export type MatchEntity = InstaQLEntity<
  AppSchema,
  "matches",
  {},
  undefined,
  true
>;

export type KillEntity = InstaQLEntity<AppSchema, "kills", {}, undefined, true>;

export type LoadoutEntity = InstaQLEntity<
  AppSchema,
  "loadouts",
  {},
  undefined,
  true
>;

export type MatchPresencePeer = PresencePeer<AppSchema, "match">;

export type WeaponId = "assaultRifle" | "shotgun" | "pistol";

export type CharacterId = "soldier" | "cesium";

export interface WeaponSpec {
  id: WeaponId;
  label: string;
  modelPath: string;
  fireIntervalMs: number;
  reloadMs: number;
  magSize: number;
  reserveAmmo: number;
  pellets: number;
  spread: number;
  baseDamage: number;
  falloffPerMeter: number;
  armorPenetration: number;
  headshotMultiplier: number;
  automatic: boolean;
  recoilPitch: number;
  recoilYaw: number;
  muzzleFlashIntensity: number;
}

export interface WeaponRuntimeState {
  weaponId: WeaponId;
  ammoInMag: number;
  ammoReserve: number;
  lastShotAt: number;
  reloadingUntil: number | null;
}

export interface InputState {
  moveForward: boolean;
  moveBackward: boolean;
  moveLeft: boolean;
  moveRight: boolean;
  sprint: boolean;
  crouch: boolean;
  jump: boolean;
  firing: boolean;
}

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Aabb {
  min: Vec3;
  max: Vec3;
}

export interface PlayerBodyState {
  position: Vec3;
  velocity: Vec3;
  yaw: number;
  pitch: number;
  grounded: boolean;
  crouching: boolean;
}

export interface DamageState {
  health: number;
  armor: number;
}

export interface SpawnPoint {
  x: number;
  y: number;
  z: number;
}

export interface DamageResolution {
  health: number;
  armor: number;
  damageApplied: number;
  isEliminated: boolean;
}
