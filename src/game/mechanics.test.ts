import { describe, expect, it } from "vitest";
import {
  applyDamage,
  computeWeaponDamage,
  stepPlayerMovement,
  type ArenaBounds,
} from "./mechanics";
import type { Aabb, InputState, PlayerBodyState } from "./types";

const idleInput: InputState = {
  moveForward: false,
  moveBackward: false,
  moveLeft: false,
  moveRight: false,
  sprint: false,
  crouch: false,
  jump: false,
  firing: false,
};

const bounds: ArenaBounds = {
  minX: -20,
  maxX: 20,
  minZ: -20,
  maxZ: 20,
  floorY: 0,
};

function createBaseState(): PlayerBodyState {
  return {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
  };
}

describe("movement", () => {
  it("accelerates forward when moving", () => {
    const next = stepPlayerMovement(
      createBaseState(),
      { ...idleInput, moveForward: true },
      1 / 60,
      [],
      bounds,
    );

    expect(next.velocity.z).toBeLessThan(0);
  });

  it("aligns forward movement with current yaw", () => {
    const state = createBaseState();
    state.yaw = -Math.PI / 2;

    const next = stepPlayerMovement(
      state,
      { ...idleInput, moveForward: true },
      1 / 60,
      [],
      bounds,
    );

    expect(next.velocity.x).toBeGreaterThan(0);
    expect(Math.abs(next.velocity.z)).toBeLessThan(0.05);
  });

  it("resolves collisions against obstacles", () => {
    const obstacle: Aabb = {
      min: { x: -1, y: 0, z: -3 },
      max: { x: 1, y: 2, z: -1 },
    };

    const state = createBaseState();
    state.position.z = -0.9;

    const next = stepPlayerMovement(
      state,
      { ...idleInput, moveForward: true },
      1 / 30,
      [obstacle],
      bounds,
    );

    expect(next.position.z).toBeGreaterThanOrEqual(obstacle.max.z);
  });
});

describe("damage", () => {
  it("applies armor mitigation", () => {
    const result = applyDamage({ health: 100, armor: 100 }, 50, 0.3);

    expect(result.health).toBeGreaterThan(60);
    expect(result.armor).toBeLessThan(100);
  });

  it("scales weapon damage for headshots", () => {
    const body = computeWeaponDamage("pistol", 5, false);
    const headshot = computeWeaponDamage("pistol", 5, true);

    expect(headshot).toBeGreaterThan(body);
  });
});
