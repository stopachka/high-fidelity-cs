# SHADOW PROTOCOL (Counter-Strike-like Instant FPS)

High-fidelity browser FPS prototype with:

- Real-time multiplayer over Instant rooms (presence + topics)
- Persistent kill feed + scoreboard in Instant entities
- First-person movement, recoil, headshots, respawn loop
- Real 3D character and weapon meshes
- Dynamic HUD, minimap, and procedural tactical sound engine

## Run

```bash
bun install
bun run dev
```

Open in 2+ tabs and join the same match code to test multiplayer.

## Controls

- `W/A/S/D`: move
- `Shift`: sprint
- `C` or `Ctrl`: crouch
- `Space`: jump
- `Mouse Left`: fire
- `1/2/3`: switch weapons
- `R`: reload

## Validation

```bash
bun run typecheck
bun run test
bun run build
```

## Backend (Instant)

Schema/perms files:

- `src/instant.schema.ts`
- `src/instant.perms.ts`

Push changes:

```bash
npx instant-cli push schema --yes
npx instant-cli push perms --yes
```

## Asset Licenses

See `public/assets/ATTRIBUTION.md`.
