import { WEAPONS } from "./weapons";
import type {
  Aabb,
  DamageResolution,
  DamageState,
  InputState,
  PlayerBodyState,
  SpawnPoint,
  Vec3,
  WeaponId,
} from "./types";

export const PLAYER_RADIUS = 0.34;
export const PLAYER_HEIGHT_STANDING = 1.72;
export const PLAYER_HEIGHT_CROUCHING = 1.24;

const WALK_SPEED = 5.6;
const SPRINT_SPEED = 8.8;
const CROUCH_SPEED = 3.2;
const ACCELERATION = 48;
const FRICTION = 32;
const GRAVITY = 26;
const JUMP_VELOCITY = 8.9;

export interface ArenaBounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
  floorY: number;
}

export function stepPlayerMovement(
  state: PlayerBodyState,
  input: InputState,
  dt: number,
  obstacles: Aabb[],
  bounds: ArenaBounds,
): PlayerBodyState {
  const desiredCrouch = input.crouch;
  const speed = desiredCrouch
    ? CROUCH_SPEED
    : input.sprint && input.moveForward && !input.moveBackward
      ? SPRINT_SPEED
      : WALK_SPEED;

  const localX = Number(input.moveRight) - Number(input.moveLeft);
  const localZ = Number(input.moveForward) - Number(input.moveBackward);

  const cosYaw = Math.cos(state.yaw);
  const sinYaw = Math.sin(state.yaw);

  // Map local strafing/forward input to world space aligned with camera yaw.
  // Camera forward is -Z in local space, rotated by yaw.
  const worldX = localX * cosYaw - localZ * sinYaw;
  const worldZ = -localX * sinYaw - localZ * cosYaw;
  const wishLength = Math.hypot(worldX, worldZ);

  let nextVelocityX = state.velocity.x;
  let nextVelocityZ = state.velocity.z;

  if (wishLength > 0) {
    const normalizedX = worldX / wishLength;
    const normalizedZ = worldZ / wishLength;
    const targetX = normalizedX * speed;
    const targetZ = normalizedZ * speed;

    nextVelocityX = approach(nextVelocityX, targetX, ACCELERATION * dt);
    nextVelocityZ = approach(nextVelocityZ, targetZ, ACCELERATION * dt);
  } else {
    nextVelocityX = approach(nextVelocityX, 0, FRICTION * dt);
    nextVelocityZ = approach(nextVelocityZ, 0, FRICTION * dt);
  }

  let nextVelocityY = state.velocity.y;
  let nextGrounded = state.grounded;

  if (state.grounded && input.jump && !desiredCrouch) {
    nextVelocityY = JUMP_VELOCITY;
    nextGrounded = false;
  } else {
    nextVelocityY -= GRAVITY * dt;
  }

  const nextPosition: Vec3 = {
    x: clamp(
      state.position.x + nextVelocityX * dt,
      bounds.minX + PLAYER_RADIUS,
      bounds.maxX - PLAYER_RADIUS,
    ),
    y: state.position.y + nextVelocityY * dt,
    z: clamp(
      state.position.z + nextVelocityZ * dt,
      bounds.minZ + PLAYER_RADIUS,
      bounds.maxZ - PLAYER_RADIUS,
    ),
  };

  if (nextPosition.y < bounds.floorY) {
    nextPosition.y = bounds.floorY;
    nextVelocityY = 0;
    nextGrounded = true;
  }

  const playerHeight = desiredCrouch
    ? PLAYER_HEIGHT_CROUCHING
    : PLAYER_HEIGHT_STANDING;

  const collisionResult = resolveHorizontalCollisions(
    nextPosition,
    {
      x: nextVelocityX,
      y: nextVelocityY,
      z: nextVelocityZ,
    },
    playerHeight,
    obstacles,
  );

  return {
    ...state,
    position: collisionResult.position,
    velocity: collisionResult.velocity,
    grounded: nextGrounded,
    crouching: desiredCrouch,
  };
}

function resolveHorizontalCollisions(
  position: Vec3,
  velocity: Vec3,
  playerHeight: number,
  obstacles: Aabb[],
): { position: Vec3; velocity: Vec3 } {
  const nextPosition = { ...position };
  const nextVelocity = { ...velocity };

  const playerBottom = nextPosition.y;
  const playerTop = playerBottom + playerHeight;

  for (const obstacle of obstacles) {
    const overlapsVertically =
      playerBottom < obstacle.max.y && playerTop > obstacle.min.y;

    if (!overlapsVertically) {
      continue;
    }

    const expandedMinX = obstacle.min.x - PLAYER_RADIUS;
    const expandedMaxX = obstacle.max.x + PLAYER_RADIUS;
    const expandedMinZ = obstacle.min.z - PLAYER_RADIUS;
    const expandedMaxZ = obstacle.max.z + PLAYER_RADIUS;

    if (
      nextPosition.x <= expandedMinX ||
      nextPosition.x >= expandedMaxX ||
      nextPosition.z <= expandedMinZ ||
      nextPosition.z >= expandedMaxZ
    ) {
      continue;
    }

    const distanceToLeft = Math.abs(nextPosition.x - expandedMinX);
    const distanceToRight = Math.abs(expandedMaxX - nextPosition.x);
    const distanceToBack = Math.abs(nextPosition.z - expandedMinZ);
    const distanceToFront = Math.abs(expandedMaxZ - nextPosition.z);

    const minDistance = Math.min(
      distanceToLeft,
      distanceToRight,
      distanceToBack,
      distanceToFront,
    );

    if (minDistance === distanceToLeft) {
      nextPosition.x = expandedMinX;
      nextVelocity.x = Math.min(nextVelocity.x, 0);
    } else if (minDistance === distanceToRight) {
      nextPosition.x = expandedMaxX;
      nextVelocity.x = Math.max(nextVelocity.x, 0);
    } else if (minDistance === distanceToBack) {
      nextPosition.z = expandedMinZ;
      nextVelocity.z = Math.min(nextVelocity.z, 0);
    } else {
      nextPosition.z = expandedMaxZ;
      nextVelocity.z = Math.max(nextVelocity.z, 0);
    }
  }

  return { position: nextPosition, velocity: nextVelocity };
}

export function computeWeaponDamage(
  weaponId: WeaponId,
  distanceMeters: number,
  isHeadshot: boolean,
): number {
  const spec = WEAPONS[weaponId];
  const minimumScale = 0.28;
  const scaled = Math.max(
    minimumScale,
    1 - distanceMeters * spec.falloffPerMeter,
  );
  const headshotScale = isHeadshot ? spec.headshotMultiplier : 1;

  return Math.max(1, Math.round(spec.baseDamage * scaled * headshotScale));
}

export function applyDamage(
  state: DamageState,
  rawDamage: number,
  armorPenetration: number,
): DamageResolution {
  const armorBlockScale = clamp(1 - armorPenetration, 0, 1);
  const armorToSpend = Math.min(state.armor, rawDamage * armorBlockScale * 0.65);
  const healthDamage = rawDamage - armorToSpend * 0.55;

  const nextArmor = Math.max(0, state.armor - armorToSpend);
  const nextHealth = Math.max(0, state.health - healthDamage);

  return {
    health: nextHealth,
    armor: nextArmor,
    damageApplied: state.health - nextHealth,
    isEliminated: nextHealth <= 0,
  };
}

export function pickSpawnPoint(
  matchCode: string,
  playerName: string,
  spawnPoints: SpawnPoint[],
  wave: number,
): SpawnPoint {
  if (spawnPoints.length === 0) {
    return { x: 0, y: 0, z: 0 };
  }

  const seed = `${matchCode}:${playerName}:${wave}`;
  const hash = hashString(seed);
  return spawnPoints[Math.abs(hash) % spawnPoints.length];
}

function hashString(input: string): number {
  let hash = 0;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash << 5) - hash + input.charCodeAt(index);
    hash |= 0;
  }

  return hash;
}

function approach(current: number, target: number, maxDelta: number): number {
  if (Math.abs(target - current) <= maxDelta) {
    return target;
  }

  return current + Math.sign(target - current) * maxDelta;
}

function clamp(value: number, min: number, max: number): number {
  if (value < min) {
    return min;
  }

  if (value > max) {
    return max;
  }

  return value;
}
