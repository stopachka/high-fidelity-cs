// Docs: https://www.instantdb.com/docs/modeling-data

import { i } from "@instantdb/core";

const _schema = i.schema({
  entities: {
    $files: i.entity({
      path: i.string().unique().indexed(),
      url: i.string(),
    }),
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
      imageURL: i.string().optional(),
      type: i.string().optional(),
    }),
    matches: i.entity({
      code: i.string().unique().indexed(),
      name: i.string().indexed(),
      mode: i.string().indexed(),
      map: i.string().indexed(),
      status: i.string().indexed(),
      scoreLimit: i.number(),
      roundSeconds: i.number(),
      createdAt: i.number(),
    }),
    kills: i.entity({
      matchCode: i.string().indexed(),
      attackerPeerId: i.string().indexed(),
      attackerName: i.string().indexed(),
      victimPeerId: i.string().indexed(),
      victimName: i.string().indexed(),
      weaponId: i.string().indexed(),
      headshot: i.boolean().indexed(),
      createdAt: i.number().indexed(),
    }),
    loadouts: i.entity({
      playerName: i.string().unique().indexed(),
      primaryWeaponId: i.string().indexed(),
      secondaryWeaponId: i.string().indexed(),
      characterId: i.string().indexed(),
      updatedAt: i.number().indexed(),
    }),
  },
  links: {
    $usersLinkedPrimaryUser: {
      forward: {
        on: "$users",
        has: "one",
        label: "linkedPrimaryUser",
        onDelete: "cascade",
      },
      reverse: {
        on: "$users",
        has: "many",
        label: "linkedGuestUsers",
      },
    },
    killMatch: {
      forward: {
        on: "kills",
        has: "one",
        label: "match",
        onDelete: "cascade",
      },
      reverse: {
        on: "matches",
        has: "many",
        label: "kills",
      },
    },
  },
  rooms: {
    match: {
      presence: i.entity({
        playerName: i.string(),
        team: i.string(),
        characterId: i.string(),
        x: i.number(),
        y: i.number(),
        z: i.number(),
        yaw: i.number(),
        pitch: i.number(),
        velocityY: i.number(),
        health: i.number(),
        armor: i.number(),
        alive: i.boolean(),
        weaponId: i.string(),
        ammoInMag: i.number(),
        ammoReserve: i.number(),
        isMoving: i.boolean(),
        sprinting: i.boolean(),
        crouching: i.boolean(),
        grounded: i.boolean(),
        stateTick: i.number(),
        lastShotAt: i.number(),
      }),
      topics: {
        shot: i.entity({
          attackerPeerId: i.string(),
          weaponId: i.string(),
          originX: i.number(),
          originY: i.number(),
          originZ: i.number(),
          dirX: i.number(),
          dirY: i.number(),
          dirZ: i.number(),
          timestamp: i.number(),
        }),
        damage: i.entity({
          attackerPeerId: i.string(),
          attackerName: i.string(),
          targetPeerId: i.string(),
          damage: i.number(),
          weaponId: i.string(),
          headshot: i.boolean(),
          timestamp: i.number(),
        }),
        respawn: i.entity({
          peerId: i.string(),
          x: i.number(),
          y: i.number(),
          z: i.number(),
          timestamp: i.number(),
        }),
      },
    },
  },
});

// This helps TypeScript display nicer intellisense
type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
