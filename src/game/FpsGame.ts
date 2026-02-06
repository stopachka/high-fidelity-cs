import { id } from "@instantdb/core";
import * as THREE from "three";
import { db } from "../lib/db";
import {
  cloneCharacterTemplate,
  cloneWeaponTemplate,
  createNameTagSprite,
  loadGameAssets,
  type GameAssets,
} from "./assets";
import { TacticalAudio } from "./audio";
import {
  applyDamage,
  computeWeaponDamage,
  pickSpawnPoint,
  PLAYER_HEIGHT_CROUCHING,
  PLAYER_HEIGHT_STANDING,
  stepPlayerMovement,
  type ArenaBounds,
} from "./mechanics";
import type {
  Aabb,
  CharacterId,
  InputState,
  KillEntity,
  MatchEntity,
  MatchPresencePeer,
  PlayerBodyState,
  SpawnPoint,
  WeaponId,
  WeaponRuntimeState,
} from "./types";
import {
  beginReload,
  createInitialWeaponStates,
  tickReload,
  tryFireWeapon,
  WEAPON_ORDER,
  WEAPONS,
} from "./weapons";

const TEAM_NAMES = ["counter", "terror"] as const;
type TeamName = (typeof TEAM_NAMES)[number];
const ALLOW_TEAM_DAMAGE = true;
const REMOTE_WEAPON_WORLD_LONGEST: Record<WeaponId, number> = {
  assaultRifle: 0.62,
  shotgun: 0.66,
  pistol: 0.34,
};

type ShotEvent = {
  attackerPeerId: string;
  weaponId: string;
  originX: number;
  originY: number;
  originZ: number;
  dirX: number;
  dirY: number;
  dirZ: number;
  timestamp: number;
};

type DamageEvent = {
  attackerPeerId: string;
  attackerName: string;
  targetPeerId: string;
  damage: number;
  weaponId: string;
  headshot: boolean;
  timestamp: number;
};

type RespawnEvent = {
  peerId: string;
  x: number;
  y: number;
  z: number;
  timestamp: number;
};

interface RemotePlayer {
  peerId: string;
  playerName: string;
  team: TeamName;
  group: THREE.Group;
  weaponSocket: THREE.Object3D;
  weapon: THREE.Group;
  weaponId: WeaponId;
  targetPosition: THREE.Vector3;
  targetYaw: number;
  alive: boolean;
  characterId: CharacterId;
  headY: number;
  isMoving: boolean;
  mixer: THREE.AnimationMixer | null;
  idleAction: THREE.AnimationAction | null;
  moveAction: THREE.AnimationAction | null;
  moveBlend: number;
}

interface HudRefs {
  lobby: HTMLDivElement;
  lobbyStartButton: HTMLButtonElement;
  playerInput: HTMLInputElement;
  matchInput: HTMLInputElement;
  statusText: HTMLParagraphElement;
  connectStatus: HTMLSpanElement;
  playersOnline: HTMLSpanElement;
  healthValue: HTMLSpanElement;
  armorValue: HTMLSpanElement;
  ammoValue: HTMLSpanElement;
  weaponValue: HTMLSpanElement;
  killsValue: HTMLSpanElement;
  deathsValue: HTMLSpanElement;
  feed: HTMLDivElement;
  scoreboard: HTMLDivElement;
  roundTimer: HTMLSpanElement;
  toast: HTMLDivElement;
  minimap: HTMLCanvasElement;
}

interface ShotTracer {
  line: THREE.Line<THREE.BufferGeometry, THREE.LineBasicMaterial>;
  ttl: number;
  maxTtl: number;
}

const DEFAULT_MATCH_CODE = "DUST-SIM";
const WORLD_HALF_SIZE = 31;

export class FpsGame {
  private readonly root: HTMLElement;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(78, 1, 0.03, 300);
  private readonly renderer = new THREE.WebGLRenderer({ antialias: true });
  private readonly clock = new THREE.Clock();
  private readonly audio = new TacticalAudio();
  private readonly input: InputState = {
    moveForward: false,
    moveBackward: false,
    moveLeft: false,
    moveRight: false,
    sprint: false,
    crouch: false,
    jump: false,
    firing: false,
  };
  private readonly moveBounds: ArenaBounds = {
    minX: -WORLD_HALF_SIZE,
    maxX: WORLD_HALF_SIZE,
    minZ: -WORLD_HALF_SIZE,
    maxZ: WORLD_HALF_SIZE,
    floorY: 0,
  };
  private readonly spawnPoints: SpawnPoint[] = [
    { x: -8, y: 0, z: -10 },
    { x: 8, y: 0, z: -10 },
    { x: -8, y: 0, z: 10 },
    { x: 8, y: 0, z: 10 },
    { x: -14, y: 0, z: 0 },
    { x: 14, y: 0, z: 0 },
    { x: 0, y: 0, z: -16 },
    { x: 0, y: 0, z: 16 },
    { x: -16, y: 0, z: -8 },
    { x: 16, y: 0, z: 8 },
    { x: -16, y: 0, z: 8 },
    { x: 16, y: 0, z: -8 },
  ];

  private hud!: HudRefs;
  private minimapCtx: CanvasRenderingContext2D | null = null;

  private assets: GameAssets | null = null;
  private readonly mapGroup = new THREE.Group();
  private obstacles: Aabb[] = [];
  private remotePlayers = new Map<string, RemotePlayer>();
  private weaponViewModels: Record<WeaponId, THREE.Group> | null = null;

  private room: ReturnType<typeof db.joinRoom> | null = null;
  private unsubscribePresence: (() => void) | null = null;
  private unsubscribeShots: (() => void) | null = null;
  private unsubscribeDamage: (() => void) | null = null;
  private unsubscribeRespawn: (() => void) | null = null;
  private unsubscribeKills: (() => void) | null = null;
  private unsubscribeConnection: (() => void) | null = null;

  private playerBody: PlayerBodyState = {
    position: { x: 0, y: 0, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    grounded: true,
    crouching: false,
  };
  private weaponStates: Record<WeaponId, WeaponRuntimeState> =
    createInitialWeaponStates();
  private activeWeapon: WeaponId = "assaultRifle";

  private localHealth = 100;
  private localArmor = 100;
  private localAlive = true;
  private localTeam: TeamName = "counter";
  private localCharacter: CharacterId = "soldier";

  private localPlayerName = "Operator";
  private localLoadoutId: string | null = null;
  private localPeerId = "";
  private matchCode = DEFAULT_MATCH_CODE;
  private matchId: string | null = null;
  private matchCreatedAt = Date.now();
  private roundSeconds = 180;
  private scoreLimit = 35;

  private lastPresenceSentAt = 0;
  private lastFootstepAt = 0;
  private viewKickback = 0;
  private viewRoll = 0;
  private spawnWave = 0;
  private respawnAt: number | null = null;
  private frameHandle = 0;
  private previousRoundSecond = -1;

  private isPointerLocked = false;
  private matchActive = false;

  private killFeed: KillEntity[] = [];
  private localKills = 0;
  private localDeaths = 0;
  private shotTracers: ShotTracer[] = [];

  constructor(root: HTMLElement) {
    this.root = root;
    this.initializeDom();
    this.configureRenderer();
    this.configureScene();
    this.installEventHandlers();
    this.buildMapGeometry();
  }

  async init(): Promise<void> {
    this.setStatus("Loading cinematic assets...");

    try {
      this.assets = await loadGameAssets();
      this.buildMapGeometry();
      this.setupWeaponViewModels();
      this.setStatus("Assets loaded. Configure your call-sign and deploy.");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.setStatus(`Asset load failed: ${message}`);
      return;
    }

    this.unsubscribeConnection = db.subscribeConnectionStatus((status) => {
      this.hud.connectStatus.textContent = status;
    });

    this.clock.start();
    this.animate();
  }

  private initializeDom(): void {
    this.root.innerHTML = `
      <div class="tactical-shell">
        <div class="tactical-lobby active">
          <div class="lobby-card">
            <h1>SHADOW PROTOCOL</h1>
            <p>Counter-Strike style multiplayer combat with real-time Instant sync.</p>
            <label for="player-call-sign">Call-sign</label>
            <input id="player-call-sign" name="player-call-sign" data-player-name maxlength="18" placeholder="Operator" value="Operator" />
            <label for="match-code">Match Code</label>
            <input id="match-code" name="match-code" data-match-code maxlength="18" placeholder="DUST-SIM" value="DUST-SIM" />
            <button data-start-match>Deploy</button>
            <p class="status" data-status>Loading...</p>
          </div>
        </div>

        <div class="hud-layer">
          <div class="hud-top">
            <div class="hud-pill">Connection: <span data-connection>connecting</span></div>
            <div class="hud-pill">Online: <span data-online>1</span></div>
            <div class="hud-pill">Round: <span data-round>03:00</span></div>
          </div>

          <div class="hud-left">
            <div class="vital"><span>HP</span><strong data-health>100</strong></div>
            <div class="vital"><span>AR</span><strong data-armor>100</strong></div>
            <div class="vital"><span>Weapon</span><strong data-weapon>AR-44 Viper</strong></div>
            <div class="vital"><span>Ammo</span><strong data-ammo>30 / 120</strong></div>
            <div class="vital"><span>K/D</span><strong data-kills>0</strong>/<strong data-deaths>0</strong></div>
          </div>

          <div class="hud-right">
            <h3>Top Fraggers</h3>
            <div data-scoreboard class="scoreboard"></div>
            <h3>Kill Feed</h3>
            <div data-feed class="feed"></div>
          </div>

          <canvas data-minimap width="220" height="220" class="minimap"></canvas>
          <div data-toast class="toast"></div>
          <div class="crosshair" aria-hidden="true"></div>
        </div>
      </div>
    `;

    const lobby = this.root.querySelector<HTMLDivElement>(".tactical-lobby");
    const lobbyStartButton = this.root.querySelector<HTMLButtonElement>(
      "[data-start-match]",
    );
    const playerInput = this.root.querySelector<HTMLInputElement>(
      "[data-player-name]",
    );
    const matchInput = this.root.querySelector<HTMLInputElement>(
      "[data-match-code]",
    );
    const statusText = this.root.querySelector<HTMLParagraphElement>(
      "[data-status]",
    );
    const connectStatus = this.root.querySelector<HTMLSpanElement>(
      "[data-connection]",
    );
    const playersOnline = this.root.querySelector<HTMLSpanElement>("[data-online]");
    const healthValue = this.root.querySelector<HTMLSpanElement>("[data-health]");
    const armorValue = this.root.querySelector<HTMLSpanElement>("[data-armor]");
    const ammoValue = this.root.querySelector<HTMLSpanElement>("[data-ammo]");
    const weaponValue = this.root.querySelector<HTMLSpanElement>("[data-weapon]");
    const killsValue = this.root.querySelector<HTMLSpanElement>("[data-kills]");
    const deathsValue = this.root.querySelector<HTMLSpanElement>("[data-deaths]");
    const feed = this.root.querySelector<HTMLDivElement>("[data-feed]");
    const scoreboard = this.root.querySelector<HTMLDivElement>("[data-scoreboard]");
    const roundTimer = this.root.querySelector<HTMLSpanElement>("[data-round]");
    const toast = this.root.querySelector<HTMLDivElement>("[data-toast]");
    const minimap = this.root.querySelector<HTMLCanvasElement>("[data-minimap]");

    if (
      !lobby ||
      !lobbyStartButton ||
      !playerInput ||
      !matchInput ||
      !statusText ||
      !connectStatus ||
      !playersOnline ||
      !healthValue ||
      !armorValue ||
      !ammoValue ||
      !weaponValue ||
      !killsValue ||
      !deathsValue ||
      !feed ||
      !scoreboard ||
      !roundTimer ||
      !toast ||
      !minimap
    ) {
      throw new Error("HUD initialization failed");
    }

    this.hud = {
      lobby,
      lobbyStartButton,
      playerInput,
      matchInput,
      statusText,
      connectStatus,
      playersOnline,
      healthValue,
      armorValue,
      ammoValue,
      weaponValue,
      killsValue,
      deathsValue,
      feed,
      scoreboard,
      roundTimer,
      toast,
      minimap,
    };

    this.minimapCtx = minimap.getContext("2d");
  }

  private configureRenderer(): void {
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.36;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;

    this.root.querySelector(".tactical-shell")?.prepend(this.renderer.domElement);
  }

  private configureScene(): void {
    this.scene.fog = new THREE.FogExp2("#0f233c", 0.0015);

    this.camera.position.set(0, 1.58, 0);
    this.camera.rotation.order = "YXZ";

    const skyTexture = buildSkyTexture();
    skyTexture.mapping = THREE.EquirectangularReflectionMapping;
    const pmremGenerator = new THREE.PMREMGenerator(this.renderer);
    const environment = pmremGenerator.fromEquirectangular(skyTexture).texture;
    pmremGenerator.dispose();
    skyTexture.dispose();

    this.scene.background = environment;
    this.scene.environment = environment;

    const hemi = new THREE.HemisphereLight("#b6dbff", "#203248", 1.28);
    this.scene.add(hemi);

    const ambient = new THREE.AmbientLight("#9bb9d7", 0.7);
    this.scene.add(ambient);

    const dir = new THREE.DirectionalLight("#ffdcb1", 2.65);
    dir.position.set(16, 22, 7);
    dir.castShadow = true;
    dir.shadow.mapSize.set(2048, 2048);
    dir.shadow.camera.left = -42;
    dir.shadow.camera.right = 42;
    dir.shadow.camera.top = 42;
    dir.shadow.camera.bottom = -42;
    dir.shadow.camera.near = 0.1;
    dir.shadow.camera.far = 90;
    dir.shadow.bias = -0.0002;
    this.scene.add(dir);

    const rim = new THREE.SpotLight("#78cbff", 5.2, 95, Math.PI / 4.8, 0.44, 1.3);
    rim.position.set(-12, 18, -8);
    rim.target.position.set(0, 0, 0);
    this.scene.add(rim);
    this.scene.add(rim.target);

    const fillA = new THREE.PointLight("#6da8ff", 3.2, 72, 1.55);
    fillA.position.set(-26, 8, 26);
    this.scene.add(fillA);

    const fillB = new THREE.PointLight("#ffa86d", 2.9, 72, 1.6);
    fillB.position.set(26, 8, -26);
    this.scene.add(fillB);

    const floorTexture = buildTacticalFloorTexture();
    floorTexture.wrapS = THREE.RepeatWrapping;
    floorTexture.wrapT = THREE.RepeatWrapping;
    floorTexture.repeat.set(18, 18);

    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(96, 96),
      new THREE.MeshStandardMaterial({
        map: floorTexture,
        roughness: 0.93,
        metalness: 0.04,
        color: "#d8e1ee",
      }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -0.05;
    floor.receiveShadow = true;
    this.scene.add(floor);

    this.scene.add(this.mapGroup);
    this.scene.add(this.camera);
  }

  private buildMapGeometry(): void {
    this.obstacles = [];
    this.clearMapGroup();

    this.buildFallbackArena();

    if (this.assets?.arenaTemplate) {
      this.addCityBackdrop(this.assets.arenaTemplate);
    }

    this.addMapAccentLights();
  }

  private buildFallbackArena(): void {
    const maxAnisotropy = Math.min(8, this.renderer.capabilities.getMaxAnisotropy());
    const concreteTexture = buildConcreteTexture("#24384f", "#1d2c41", "#5f7490");
    prepareArenaTexture(concreteTexture, 4.5, 4.5, maxAnisotropy);

    const steelTexture = buildPanelTexture("#71839a", "#4a617c", "#2e435a");
    prepareArenaTexture(steelTexture, 3.8, 3.8, maxAnisotropy);

    const crateTexture = buildCrateTexture();
    prepareArenaTexture(crateTexture, 2.8, 2.8, maxAnisotropy);

    const trimTexture = buildPanelTexture("#4a5d77", "#26384d", "#192738");
    prepareArenaTexture(trimTexture, 7.5, 1.2, maxAnisotropy);

    const boundary = new THREE.MeshStandardMaterial({
      map: concreteTexture,
      color: "#96aaca",
      roughness: 0.78,
      metalness: 0.11,
    });
    const concrete = new THREE.MeshStandardMaterial({
      map: concreteTexture.clone(),
      color: "#d4dfef",
      roughness: 0.74,
      metalness: 0.08,
    });
    const steel = new THREE.MeshStandardMaterial({
      map: steelTexture,
      color: "#abc4e0",
      roughness: 0.46,
      metalness: 0.68,
    });
    const crate = new THREE.MeshStandardMaterial({
      map: crateTexture,
      color: "#deb58e",
      roughness: 0.82,
      metalness: 0.08,
    });
    const darkSteel = new THREE.MeshStandardMaterial({
      map: trimTexture,
      color: "#7089a8",
      roughness: 0.54,
      metalness: 0.52,
    });
    const neon = new THREE.MeshStandardMaterial({
      color: "#b9ecff",
      emissive: "#2d90d8",
      emissiveIntensity: 1.4,
      roughness: 0.18,
      metalness: 0.6,
    });
    const amberNeon = new THREE.MeshStandardMaterial({
      color: "#ffd8b3",
      emissive: "#d78a3e",
      emissiveIntensity: 1.28,
      roughness: 0.2,
      metalness: 0.52,
    });

    // Perimeter shell.
    this.addBlock(64, 5.8, 1.8, 0, 2.9, -31, boundary);
    this.addBlock(64, 5.8, 1.8, 0, 2.9, 31, boundary);
    this.addBlock(1.8, 5.8, 64, -31, 2.9, 0, boundary);
    this.addBlock(1.8, 5.8, 64, 31, 2.9, 0, boundary);
    this.addBlock(64, 0.6, 1.2, 0, 5.88, -30.9, darkSteel, false);
    this.addBlock(64, 0.6, 1.2, 0, 5.88, 30.9, darkSteel, false);
    this.addBlock(1.2, 0.6, 64, -30.9, 5.88, 0, darkSteel, false);
    this.addBlock(1.2, 0.6, 64, 30.9, 5.88, 0, darkSteel, false);

    // Mid lane combat bowl.
    this.addBlock(12.4, 2.8, 3.4, 0, 1.4, -6.4, concrete);
    this.addBlock(12.4, 2.8, 3.4, 0, 1.4, 6.4, concrete);
    this.addBlock(3.4, 2.8, 12.4, -6.4, 1.4, 0, concrete);
    this.addBlock(3.4, 2.8, 12.4, 6.4, 1.4, 0, concrete);
    this.addBlock(4.8, 2.6, 4.8, 0, 1.3, 0, steel);
    this.addBlock(8.2, 0.45, 2.2, 0, 3.95, -0.2, darkSteel, false);

    // Side bomb sites and upper trims.
    for (const [x, z] of [
      [-20, -10],
      [-20, 10],
      [20, -10],
      [20, 10],
    ] as const) {
      this.addBlock(8.8, 3, 6.8, x, 1.5, z, concrete);
      this.addBlock(5.5, 0.7, 4.6, x, 3.3, z, darkSteel, false);
      this.addBlock(1.2, 3.8, 1.2, x - 4.1, 1.9, z - 2.9, steel, false);
      this.addBlock(1.2, 3.8, 1.2, x + 4.1, 1.9, z + 2.9, steel, false);
    }

    for (const [x, z] of [
      [-12, -16],
      [-12, 16],
      [12, -16],
      [12, 16],
      [-6, -20],
      [6, -20],
      [-6, 20],
      [6, 20],
    ] as const) {
      this.addBlock(2.6, 3.7, 7.8, x, 1.85, z, steel);
    }

    // Side catwalk and utility pipes.
    this.addBlock(14, 0.55, 2, -23, 4.8, -12, darkSteel, false);
    this.addBlock(14, 0.55, 2, -23, 4.8, 12, darkSteel, false);
    this.addBlock(14, 0.55, 2, 23, 4.8, -12, darkSteel, false);
    this.addBlock(14, 0.55, 2, 23, 4.8, 12, darkSteel, false);
    this.addBlock(1.1, 4.5, 1.1, -16, 2.25, -23, steel, false);
    this.addBlock(1.1, 4.5, 1.1, 16, 2.25, -23, steel, false);
    this.addBlock(1.1, 4.5, 1.1, -16, 2.25, 23, steel, false);
    this.addBlock(1.1, 4.5, 1.1, 16, 2.25, 23, steel, false);

    for (let step = 0; step < 5; step += 1) {
      const y = 0.2 + step * 0.38;
      this.addBlock(3.1, 0.38, 1.3, -24 + step * 1.12, y, -0.84, steel);
      this.addBlock(3.1, 0.38, 1.3, -24 + step * 1.12, y, 0.84, steel);
      this.addBlock(3.1, 0.38, 1.3, 24 - step * 1.12, y, -0.84, steel);
      this.addBlock(3.1, 0.38, 1.3, 24 - step * 1.12, y, 0.84, steel);
    }

    for (const [x, z] of [
      [-18, -14],
      [-18, 14],
      [18, -14],
      [18, 14],
      [-8, -18],
      [8, -18],
      [-8, 18],
      [8, 18],
      [-4, -9],
      [4, -9],
      [-4, 9],
      [4, 9],
      [-22, 0],
      [22, 0],
    ] as const) {
      this.addCrateStack(x, z, crate);
    }

    for (const [x, z] of [
      [-14, -2],
      [-14, 2],
      [14, -2],
      [14, 2],
      [0, -15],
      [0, 15],
      [-22, -8],
      [22, 8],
    ] as const) {
      this.addBarrelCluster(x, z, darkSteel);
    }

    // Painted lane lines.
    this.addBlock(0.16, 0.05, 58, 0, 0.025, 0, neon, false);
    this.addBlock(58, 0.05, 0.16, 0, 0.025, 0, amberNeon, false);

    // Light panels and signage.
    this.addDecorPanel(-31.2, 2.7, -9, neon);
    this.addDecorPanel(-31.2, 2.7, 9, amberNeon);
    this.addDecorPanel(31.2, 2.7, -9, amberNeon);
    this.addDecorPanel(31.2, 2.7, 9, neon);
    this.addDecorPanel(-11, 2.9, -31.2, neon, true);
    this.addDecorPanel(11, 2.9, 31.2, amberNeon, true);

    const core = new THREE.Mesh(
      new THREE.CylinderGeometry(0.45, 0.45, 2.3, 24),
      new THREE.MeshStandardMaterial({
        color: "#9fc3ee",
        emissive: "#57b2ff",
        emissiveIntensity: 1.65,
        roughness: 0.2,
        metalness: 0.78,
      }),
    );
    core.position.set(0, 1.18, 0);
    this.mapGroup.add(core);
  }

  private addCityBackdrop(template: THREE.Group): void {
    const skylineRing = new THREE.Group();

    const placements = [
      { angle: 0, radius: 92, yawOffset: Math.PI * 0.02, scale: 92 },
      { angle: Math.PI * 0.5, radius: 94, yawOffset: -Math.PI * 0.08, scale: 84 },
      { angle: Math.PI, radius: 90, yawOffset: Math.PI * 0.12, scale: 88 },
      { angle: Math.PI * 1.5, radius: 94, yawOffset: -Math.PI * 0.1, scale: 84 },
      { angle: Math.PI * 0.25, radius: 78, yawOffset: Math.PI * 0.08, scale: 70 },
      { angle: Math.PI * 0.75, radius: 78, yawOffset: -Math.PI * 0.08, scale: 70 },
      { angle: Math.PI * 1.25, radius: 78, yawOffset: Math.PI * 0.08, scale: 70 },
      { angle: Math.PI * 1.75, radius: 78, yawOffset: -Math.PI * 0.08, scale: 70 },
    ] as const;

    for (const placement of placements) {
      const skyline = template.clone(true);
      fitObjectLongestEdge(skyline, placement.scale);

      skyline.position.set(
        Math.sin(placement.angle) * placement.radius,
        -1.6,
        Math.cos(placement.angle) * placement.radius,
      );
      skyline.rotation.y = placement.angle + Math.PI + placement.yawOffset;

      skyline.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) {
          return;
        }

        mesh.castShadow = false;
        mesh.receiveShadow = false;

        const applyMaterial = (material: THREE.Material) => {
          if (
            material instanceof THREE.MeshStandardMaterial ||
            material instanceof THREE.MeshPhysicalMaterial
          ) {
            material.roughness = Math.max(material.roughness, 0.42);
            material.envMapIntensity = Math.max(material.envMapIntensity, 1.55);
            material.color.multiplyScalar(1.12);
          }
        };

        if (Array.isArray(mesh.material)) {
          for (const material of mesh.material) {
            applyMaterial(material);
          }
        } else {
          applyMaterial(mesh.material);
        }
      });

      skylineRing.add(skyline);
    }

    this.mapGroup.add(skylineRing);
  }

  private clearMapGroup(): void {
    for (const child of this.mapGroup.children) {
      child.traverse((node) => {
        const mesh = node as THREE.Mesh;
        if (!mesh.isMesh) {
          return;
        }

        mesh.geometry.dispose();

        if (Array.isArray(mesh.material)) {
          mesh.material.forEach((material) => material.dispose());
        } else {
          mesh.material.dispose();
        }
      });
    }

    this.mapGroup.clear();
  }

  private addCrateStack(x: number, z: number, material: THREE.Material): void {
    this.addBlock(2.3, 2.3, 2.3, x, 1.15, z, material);

    if ((Math.round(x + z) & 1) === 0) {
      this.addBlock(2.05, 2.05, 2.05, x + 0.68, 3.28, z - 0.28, material);
    }
  }

  private addBarrelCluster(x: number, z: number, material: THREE.Material): void {
    const barrelA = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.54, 1.35, 18), material);
    barrelA.position.set(x, 0.675, z);
    barrelA.castShadow = true;
    barrelA.receiveShadow = true;
    this.mapGroup.add(barrelA);
    this.addInvisibleCollider(1.14, 1.35, 1.14, x, 0.675, z);

    const barrelB = barrelA.clone();
    barrelB.position.set(x + 0.95, 0.675, z + 0.2);
    this.mapGroup.add(barrelB);
    this.addInvisibleCollider(1.14, 1.35, 1.14, x + 0.95, 0.675, z + 0.2);
  }

  private addDecorPanel(
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    rotate = false,
  ): void {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(3.6, 1.1, 0.2), material);
    panel.position.set(x, y, z);
    if (rotate) {
      panel.rotation.y = Math.PI / 2;
    }
    panel.castShadow = false;
    panel.receiveShadow = true;
    this.mapGroup.add(panel);
  }

  private addMapAccentLights(): void {
    for (const [x, z, color] of [
      [-24, -24, "#72b6ff"],
      [24, 24, "#72b6ff"],
      [-24, 24, "#ffab75"],
      [24, -24, "#ffab75"],
      [0, 0, "#9de7ff"],
      [-18, 0, "#63b1ff"],
      [18, 0, "#63b1ff"],
    ] as const) {
      const light = new THREE.PointLight(color, 3.5, 24, 1.9);
      light.position.set(x, 4.8, z);
      this.mapGroup.add(light);
    }

    const overhead = new THREE.SpotLight(
      "#9bd2ff",
      4.6,
      90,
      Math.PI / 5.2,
      0.42,
      1.5,
    );
    overhead.position.set(0, 28, 0);
    overhead.target.position.set(0, 0, 0);
    overhead.castShadow = false;
    this.mapGroup.add(overhead);
    this.mapGroup.add(overhead.target);
  }

  private addBlock(
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    material: THREE.Material,
    isCollider = true,
  ): void {
    const block = new THREE.Mesh(
      new THREE.BoxGeometry(width, height, depth),
      material,
    );
    block.position.set(x, y, z);
    block.castShadow = true;
    block.receiveShadow = true;
    this.mapGroup.add(block);

    if (!isCollider) {
      return;
    }

    this.addInvisibleCollider(width, height, depth, x, y, z);
  }

  private addInvisibleCollider(
    width: number,
    height: number,
    depth: number,
    x: number,
    y: number,
    z: number,
  ): void {
    this.obstacles.push({
      min: { x: x - width / 2, y: y - height / 2, z: z - depth / 2 },
      max: { x: x + width / 2, y: y + height / 2, z: z + depth / 2 },
    });
  }

  private setupWeaponViewModels(): void {
    if (!this.assets) {
      return;
    }

    const mount = new THREE.Group();
    mount.position.set(0.28, -0.22, -0.5);
    this.camera.add(mount);

    const transforms: Record<
      WeaponId,
      {
        targetLongest: number;
        rot: [number, number, number];
        offset: [number, number, number];
      }
    > = {
      assaultRifle: {
        targetLongest: 0.65,
        rot: [0.08, Math.PI / 2 + 0.02, -0.04],
        offset: [0.02, -0.02, 0.02],
      },
      shotgun: {
        targetLongest: 0.62,
        rot: [0.08, Math.PI / 2 + 0.04, -0.04],
        offset: [0.03, -0.02, 0.04],
      },
      pistol: {
        targetLongest: 0.56,
        rot: [0.09, Math.PI / 2 + 0.06, -0.05],
        offset: [0.02, -0.08, 0.02],
      },
    };

    const viewModels = {} as Record<WeaponId, THREE.Group>;

    for (const weaponId of WEAPON_ORDER) {
      const model = cloneWeaponTemplate(this.assets.weaponTemplates[weaponId]);
      const transform = transforms[weaponId];
      fitObjectLongestEdge(model, transform.targetLongest);
      configureViewModel(model);
      model.rotation.set(...transform.rot);
      model.position.set(...transform.offset);
      model.visible = weaponId === this.activeWeapon;
      mount.add(model);
      viewModels[weaponId] = model;
    }

    const muzzle = new THREE.PointLight("#ffd4a8", 0, 10, 2);
    muzzle.position.set(0.22, 0.09, -0.36);
    mount.add(muzzle);
    this.muzzleFlashLight = muzzle;

    this.weaponMount = mount;
    this.weaponViewModels = viewModels;
  }

  private weaponMount: THREE.Group | null = null;
  private muzzleFlashLight: THREE.PointLight | null = null;

  private installEventHandlers(): void {
    this.hud.lobbyStartButton.addEventListener("click", () => {
      void this.startMatch();
    });

    window.addEventListener("resize", () => {
      this.camera.aspect = window.innerWidth / window.innerHeight;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(window.innerWidth, window.innerHeight);
    });

    window.addEventListener("keydown", (event) => {
      if (event.repeat) {
        return;
      }

      if (
        event.code === "ArrowUp" ||
        event.code === "ArrowDown" ||
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight" ||
        event.code === "Space"
      ) {
        event.preventDefault();
      }

      switch (event.code) {
        case "KeyW":
        case "ArrowUp":
          this.input.moveForward = true;
          break;
        case "KeyS":
        case "ArrowDown":
          this.input.moveBackward = true;
          break;
        case "KeyA":
        case "ArrowLeft":
          this.input.moveLeft = true;
          break;
        case "KeyD":
        case "ArrowRight":
          this.input.moveRight = true;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.input.sprint = true;
          break;
        case "KeyC":
        case "ControlLeft":
          this.input.crouch = true;
          break;
        case "Space":
          this.input.jump = true;
          break;
        case "Digit1":
          this.setActiveWeapon("assaultRifle");
          break;
        case "Digit2":
          this.setActiveWeapon("shotgun");
          break;
        case "Digit3":
          this.setActiveWeapon("pistol");
          break;
        case "KeyR":
          this.reloadActiveWeapon();
          break;
      }
    });

    window.addEventListener("keyup", (event) => {
      if (
        event.code === "ArrowUp" ||
        event.code === "ArrowDown" ||
        event.code === "ArrowLeft" ||
        event.code === "ArrowRight" ||
        event.code === "Space"
      ) {
        event.preventDefault();
      }

      switch (event.code) {
        case "KeyW":
        case "ArrowUp":
          this.input.moveForward = false;
          break;
        case "KeyS":
        case "ArrowDown":
          this.input.moveBackward = false;
          break;
        case "KeyA":
        case "ArrowLeft":
          this.input.moveLeft = false;
          break;
        case "KeyD":
        case "ArrowRight":
          this.input.moveRight = false;
          break;
        case "ShiftLeft":
        case "ShiftRight":
          this.input.sprint = false;
          break;
        case "KeyC":
        case "ControlLeft":
          this.input.crouch = false;
          break;
        case "Space":
          this.input.jump = false;
          break;
      }
    });

    this.renderer.domElement.addEventListener("mousedown", (event: MouseEvent) => {
      if (event.button !== 0) {
        return;
      }

      if (!this.isPointerLocked) {
        this.renderer.domElement.requestPointerLock();
        return;
      }

      this.input.firing = true;
      this.audio.unlock();
      this.tryFire(Date.now());
    });

    window.addEventListener("mouseup", (event: MouseEvent) => {
      if (event.button === 0) {
        this.input.firing = false;
      }
    });

    document.addEventListener("mousemove", (event: MouseEvent) => {
      if (!this.isPointerLocked || !this.localAlive) {
        return;
      }

      this.playerBody.yaw -= event.movementX * 0.0018;
      this.playerBody.pitch -= event.movementY * 0.0015;
      this.playerBody.pitch = clamp(this.playerBody.pitch, -1.45, 1.45);
    });

    document.addEventListener("pointerlockchange", () => {
      this.isPointerLocked = document.pointerLockElement === this.renderer.domElement;
      if (!this.isPointerLocked && this.matchActive) {
        this.showToast("Pointer unlocked. Click the canvas to re-engage.");
      }
    });
  }

  private async startMatch(): Promise<void> {
    const chosenName = this.hud.playerInput.value.trim();
    const chosenCode = this.hud.matchInput.value.trim().toUpperCase();

    this.localPlayerName = chosenName.length > 0 ? chosenName.slice(0, 18) : "Operator";
    this.matchCode = chosenCode.length > 0 ? chosenCode.slice(0, 18) : DEFAULT_MATCH_CODE;

    this.localTeam = this.pickTeam(this.localPlayerName, this.matchCode);
    this.localCharacter = this.localTeam === "counter" ? "soldier" : "cesium";

    this.audio.unlock();
    this.spawnWave = 0;

    const spawn = this.resolveSpawnPoint(
      pickSpawnPoint(
        this.matchCode,
        this.localPlayerName,
        this.spawnPoints,
        this.spawnWave,
      ),
    );

    this.playerBody.position = { ...spawn };
    this.playerBody.velocity = { x: 0, y: 0, z: 0 };
    this.playerBody.grounded = true;
    this.playerBody.crouching = false;
    this.orientSpawnView(spawn);

    this.weaponStates = createInitialWeaponStates();
    this.localHealth = 100;
    this.localArmor = 100;
    this.localAlive = true;
    this.localKills = 0;
    this.localDeaths = 0;

    this.hud.lobby.classList.remove("active");
    this.setStatus(`Connected as ${this.localPlayerName}. Match ${this.matchCode}.`);
    this.showToast("Mission active. Capture angles and frag out.");

    this.renderer.domElement.requestPointerLock();

    await this.ensureMatchExists();
    await this.restoreLoadout();
    this.subscribeKillFeed();
    this.joinRealtimeRoom();

    this.matchActive = true;
  }

  private pickTeam(playerName: string, matchCode: string): TeamName {
    const merged = `${matchCode}:${playerName}`;
    let hash = 0;
    for (let index = 0; index < merged.length; index += 1) {
      hash = (hash << 5) - hash + merged.charCodeAt(index);
      hash |= 0;
    }

    return TEAM_NAMES[Math.abs(hash) % TEAM_NAMES.length];
  }

  private async ensureMatchExists(): Promise<void> {
    try {
      const response = await db.queryOnce({
        matches: {
          $: {
            where: { code: this.matchCode },
          },
        },
      });

      const existing = response.data.matches[0] as MatchEntity | undefined;

      if (existing) {
        this.matchId = existing.id;
        this.matchCreatedAt = existing.createdAt;
        this.roundSeconds = existing.roundSeconds;
        this.scoreLimit = existing.scoreLimit;
        return;
      }

      const createdId = id();
      const now = Date.now();

      db.transact(
        db.tx.matches[createdId].create({
          code: this.matchCode,
          name: `${this.matchCode} // Tactical Arena`,
          mode: "Team Deathmatch",
          map: "Factory District",
          status: "live",
          scoreLimit: this.scoreLimit,
          roundSeconds: this.roundSeconds,
          createdAt: now,
        }),
      );

      this.matchId = createdId;
      this.matchCreatedAt = now;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.showToast(`Match sync issue: ${message}`);
    }
  }

  private async restoreLoadout(): Promise<void> {
    try {
      const response = await db.queryOnce({
        loadouts: {
          $: {
            where: { playerName: this.localPlayerName },
          },
        },
      });

      const loadout = response.data.loadouts[0];

      if (!loadout) {
        this.localLoadoutId = null;
        this.persistLoadout();
        return;
      }

      this.localLoadoutId = loadout.id;

      if (isWeaponId(loadout.primaryWeaponId)) {
        this.setActiveWeapon(loadout.primaryWeaponId);
      }

      if (isCharacterId(loadout.characterId)) {
        this.localCharacter = loadout.characterId;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      this.showToast(`Loadout sync issue: ${message}`);
    }
  }

  private persistLoadout(): void {
    const loadoutId = this.localLoadoutId ?? id();
    const payload = {
      playerName: this.localPlayerName,
      primaryWeaponId: this.activeWeapon,
      secondaryWeaponId: this.activeWeapon === "assaultRifle" ? "pistol" : "assaultRifle",
      characterId: this.localCharacter,
      updatedAt: Date.now(),
    };

    db.transact(db.tx.loadouts[loadoutId].update(payload));
    this.localLoadoutId = loadoutId;
  }

  private subscribeKillFeed(): void {
    this.unsubscribeKills?.();

    this.unsubscribeKills = db.subscribeQuery(
      {
        kills: {
          $: {
            where: { matchCode: this.matchCode },
            order: { createdAt: "desc" },
          },
        },
      },
      (resp) => {
        if (resp.error || !resp.data) {
          return;
        }

        this.killFeed = resp.data.kills as KillEntity[];
        this.recomputeLocalStats();
        this.renderScoreboard();
        this.renderKillFeed();
      },
    );
  }

  private joinRealtimeRoom(): void {
    this.cleanupRoomSubscriptions();

    const room = db.joinRoom("match", this.matchCode, {
      initialPresence: this.currentPresencePayload(),
    });

    this.room = room;

    this.unsubscribePresence = room.subscribePresence({}, (slice) => {
      if (slice.user?.peerId) {
        this.localPeerId = slice.user.peerId;
      }

      const activePeerIds = new Set<string>();

      for (const peer of Object.values(slice.peers) as MatchPresencePeer[]) {
        activePeerIds.add(peer.peerId);

        if (peer.peerId === this.localPeerId) {
          continue;
        }

        this.upsertRemotePlayer(peer);
      }

      for (const [peerId, remote] of this.remotePlayers.entries()) {
        if (activePeerIds.has(peerId)) {
          continue;
        }

        remote.mixer?.stopAllAction();
        remote.mixer?.uncacheRoot(remote.group);
        this.scene.remove(remote.group);
        this.remotePlayers.delete(peerId);
      }

      this.hud.playersOnline.textContent = String(
        Object.keys(slice.peers).length + (slice.user ? 1 : 0),
      );
    });

    this.unsubscribeShots = room.subscribeTopic("shot", (event: ShotEvent) => {
      this.onShotEvent(event);
    });

    this.unsubscribeDamage = room.subscribeTopic("damage", (event: DamageEvent) => {
      this.onDamageEvent(event);
    });

    this.unsubscribeRespawn = room.subscribeTopic(
      "respawn",
      (event: RespawnEvent) => {
        const remote = this.remotePlayers.get(event.peerId);
        if (!remote) {
          return;
        }

        remote.targetPosition.set(event.x, event.y, event.z);
        remote.group.position.copy(remote.targetPosition);
        remote.alive = true;
        remote.group.visible = true;
      },
    );
  }

  private currentPresencePayload() {
    const state = this.weaponStates[this.activeWeapon];

    return {
      playerName: this.localPlayerName,
      team: this.localTeam,
      characterId: this.localCharacter,
      x: this.playerBody.position.x,
      y: this.playerBody.position.y,
      z: this.playerBody.position.z,
      yaw: this.playerBody.yaw,
      pitch: this.playerBody.pitch,
      velocityY: this.playerBody.velocity.y,
      health: this.localHealth,
      armor: this.localArmor,
      alive: this.localAlive,
      weaponId: this.activeWeapon,
      ammoInMag: state.ammoInMag,
      ammoReserve: state.ammoReserve,
      isMoving:
        Math.abs(this.playerBody.velocity.x) > 0.25 ||
        Math.abs(this.playerBody.velocity.z) > 0.25,
      sprinting: this.input.sprint,
      crouching: this.playerBody.crouching,
      grounded: this.playerBody.grounded,
      stateTick: Date.now(),
      lastShotAt: state.lastShotAt,
    };
  }

  private publishPresence(now: number): void {
    if (!this.room) {
      return;
    }

    if (now - this.lastPresenceSentAt < 45) {
      return;
    }

    this.lastPresenceSentAt = now;
    this.room.publishPresence(this.currentPresencePayload());
  }

  private upsertRemotePlayer(peer: MatchPresencePeer): void {
    if (!this.assets) {
      return;
    }

    const characterId = isCharacterId(peer.characterId)
      ? peer.characterId
      : this.localCharacter;

    const weaponId = isWeaponId(peer.weaponId) ? peer.weaponId : "assaultRifle";
    const team = peer.team === "terror" ? "terror" : "counter";

    const known = this.remotePlayers.get(peer.peerId);

    if (!known) {
      const characterTemplate = this.assets.characterTemplates[characterId];
      const root = cloneCharacterTemplate(characterTemplate);
      root.position.set(peer.x ?? 0, peer.y ?? 0, peer.z ?? 0);

      tintCharacter(root, team);

      const weaponSocket = findWeaponSocket(root);
      const weapon = cloneWeaponTemplate(this.assets.weaponTemplates[weaponId]);
      configureWorldWeaponAttachment(weapon, weaponSocket !== root);
      weaponSocket.add(weapon);
      if (weaponSocket !== root) {
        orientWeaponToCharacterForward(weapon, weaponSocket, root);
        fitObjectWorldLongestEdge(weapon, REMOTE_WEAPON_WORLD_LONGEST[weaponId]);
      }

      const nameTag = createNameTagSprite(
        peer.playerName || "Unknown",
        peer.team || "counter",
      );
      root.add(nameTag);

      const isMoving = peer.isMoving ?? false;
      const animation = this.createRemoteAnimationRig(
        root,
        characterTemplate.clips,
        isMoving,
      );

      this.scene.add(root);

      this.remotePlayers.set(peer.peerId, {
        peerId: peer.peerId,
        playerName: peer.playerName || "Unknown",
        team,
        group: root,
        weaponSocket,
        weapon,
        weaponId,
        targetPosition: new THREE.Vector3(peer.x ?? 0, peer.y ?? 0, peer.z ?? 0),
        targetYaw: peer.yaw ?? 0,
        alive: peer.alive ?? true,
        characterId,
        headY: 1.56,
        isMoving,
        mixer: animation.mixer,
        idleAction: animation.idleAction,
        moveAction: animation.moveAction,
        moveBlend: animation.moveBlend,
      });

      return;
    }

    known.targetPosition.set(peer.x ?? 0, peer.y ?? 0, peer.z ?? 0);
    known.targetYaw = peer.yaw ?? known.targetYaw;
    known.alive = peer.alive ?? known.alive;
    known.group.visible = known.alive;
    known.isMoving = peer.isMoving ?? known.isMoving;

    if (isWeaponId(peer.weaponId) && peer.weaponId !== known.weaponId) {
      this.swapRemoteWeapon(known, peer.weaponId);
    }
  }

  private swapRemoteWeapon(remote: RemotePlayer, weaponId: WeaponId): void {
    if (!this.assets) {
      return;
    }

    remote.weapon.parent?.remove(remote.weapon);
    const nextWeapon = cloneWeaponTemplate(this.assets.weaponTemplates[weaponId]);
    configureWorldWeaponAttachment(nextWeapon, remote.weaponSocket !== remote.group);
    remote.weaponSocket.add(nextWeapon);
    if (remote.weaponSocket !== remote.group) {
      orientWeaponToCharacterForward(nextWeapon, remote.weaponSocket, remote.group);
      fitObjectWorldLongestEdge(nextWeapon, REMOTE_WEAPON_WORLD_LONGEST[weaponId]);
    }
    remote.weapon = nextWeapon;
    remote.weaponId = weaponId;
  }

  private createRemoteAnimationRig(
    root: THREE.Group,
    clips: THREE.AnimationClip[],
    isMoving: boolean,
  ): {
    mixer: THREE.AnimationMixer | null;
    idleAction: THREE.AnimationAction | null;
    moveAction: THREE.AnimationAction | null;
    moveBlend: number;
  } {
    if (clips.length === 0) {
      return {
        mixer: null,
        idleAction: null,
        moveAction: null,
        moveBlend: isMoving ? 1 : 0,
      };
    }

    const mixer = new THREE.AnimationMixer(root);
    const { idleClip, moveClip } = pickRemoteClips(clips);

    const idleAction = idleClip ? mixer.clipAction(idleClip) : null;
    const moveAction = moveClip ? mixer.clipAction(moveClip) : null;
    const moveBlend = isMoving ? 1 : 0;

    if (idleAction) {
      idleAction.enabled = true;
      idleAction.setLoop(THREE.LoopRepeat, Infinity);
      idleAction.clampWhenFinished = false;
      idleAction.play();
      idleAction.setEffectiveWeight(1 - moveBlend);
    }

    if (moveAction) {
      moveAction.enabled = true;
      moveAction.setLoop(THREE.LoopRepeat, Infinity);
      moveAction.clampWhenFinished = false;
      moveAction.play();
      moveAction.setEffectiveWeight(moveBlend);
    }

    return {
      mixer,
      idleAction,
      moveAction,
      moveBlend,
    };
  }

  private onShotEvent(event: ShotEvent): void {
    if (event.attackerPeerId === this.localPeerId) {
      return;
    }

    if (!isWeaponId(event.weaponId)) {
      return;
    }

    const distance = Math.hypot(
      event.originX - this.playerBody.position.x,
      event.originY - (this.playerBody.position.y + 1.5),
      event.originZ - this.playerBody.position.z,
    );

    if (distance < 55 && isWeaponId(event.weaponId)) {
      this.audio.playShot(event.weaponId);

      this.spawnShotTracer(
        new THREE.Vector3(event.originX, event.originY, event.originZ),
        new THREE.Vector3(event.dirX, event.dirY, event.dirZ).normalize(),
        event.weaponId,
        false,
      );
    }
  }

  private onDamageEvent(event: DamageEvent): void {
    if (!this.localAlive || event.targetPeerId !== this.localPeerId) {
      return;
    }

    if (!isWeaponId(event.weaponId)) {
      return;
    }

    const spec = WEAPONS[event.weaponId];
    const result = applyDamage(
      {
        health: this.localHealth,
        armor: this.localArmor,
      },
      event.damage,
      spec.armorPenetration,
    );

    this.localHealth = result.health;
    this.localArmor = result.armor;

    this.audio.playHit(event.headshot);

    if (result.isEliminated) {
      this.handleLocalDeath(event.attackerPeerId, event.attackerName, event.weaponId, event.headshot);
    }
  }

  private handleLocalDeath(
    attackerPeerId: string,
    attackerName: string,
    weaponId: WeaponId,
    headshot: boolean,
  ): void {
    if (!this.localAlive) {
      return;
    }

    this.localAlive = false;
    this.input.firing = false;
    this.respawnAt = Date.now() + 4200;
    this.localDeaths += 1;

    this.audio.playDeath();
    this.showToast(`Eliminated by ${attackerName || "Unknown"}. Respawn in 4s.`);

    const killId = id();
    const payload = db.tx.kills[killId].create({
      matchCode: this.matchCode,
      attackerPeerId,
      attackerName: attackerName || "Unknown",
      victimPeerId: this.localPeerId,
      victimName: this.localPlayerName,
      weaponId,
      headshot,
      createdAt: Date.now(),
    });

    if (this.matchId) {
      db.transact(payload.link({ match: this.matchId }));
    } else {
      db.transact(payload);
    }

    this.publishPresence(Date.now());
  }

  private animate = (): void => {
    const dt = Math.min(0.033, this.clock.getDelta());
    const now = Date.now();

    this.updateRoundTimer(now);
    this.updateLocalState(dt, now);
    this.updateRemotePlayers(dt);
    this.updateWeaponViewmodel(dt, now);
    this.updateShotTracers(dt);
    this.publishPresence(now);
    this.updateHudValues();
    this.drawMinimap();

    this.renderer.render(this.scene, this.camera);
    this.frameHandle = window.requestAnimationFrame(this.animate);
  };

  private updateLocalState(dt: number, now: number): void {
    for (const weaponId of WEAPON_ORDER) {
      this.weaponStates[weaponId] = tickReload(this.weaponStates[weaponId], now);
    }

    if (!this.localAlive) {
      if (this.respawnAt !== null && now >= this.respawnAt) {
        this.respawnAt = null;
        this.respawnLocalPlayer();
      }
      return;
    }

    this.playerBody = stepPlayerMovement(
      this.playerBody,
      this.input,
      dt,
      this.obstacles,
      this.moveBounds,
    );

    const eyeHeight = this.playerBody.crouching
      ? PLAYER_HEIGHT_CROUCHING - 0.1
      : PLAYER_HEIGHT_STANDING - 0.14;

    this.camera.position.set(
      this.playerBody.position.x,
      this.playerBody.position.y + eyeHeight,
      this.playerBody.position.z,
    );
    this.camera.rotation.y = this.playerBody.yaw;
    this.camera.rotation.x = this.playerBody.pitch;

    this.tryAutomaticFire(now);
    this.maybePlayFootsteps(now);
  }

  private updateRemotePlayers(dt: number): void {
    for (const remote of this.remotePlayers.values()) {
      const positionLerp = 1 - Math.exp(-dt * 12);
      remote.group.position.lerp(remote.targetPosition, positionLerp);
      remote.group.rotation.y = lerpAngle(
        remote.group.rotation.y,
        remote.targetYaw,
        positionLerp,
      );

      const desiredMoveBlend = remote.isMoving ? 1 : 0;
      remote.moveBlend = THREE.MathUtils.lerp(remote.moveBlend, desiredMoveBlend, dt * 9);

      if (remote.moveAction) {
        remote.moveAction.setEffectiveWeight(remote.moveBlend);
      }

      if (remote.idleAction) {
        remote.idleAction.setEffectiveWeight(1 - remote.moveBlend);
      }

      remote.mixer?.update(dt * (0.9 + remote.moveBlend * 0.35));
    }
  }

  private updateWeaponViewmodel(dt: number, now: number): void {
    if (!this.weaponMount) {
      return;
    }

    this.viewKickback = THREE.MathUtils.lerp(this.viewKickback, 0, dt * 17);
    this.viewRoll = THREE.MathUtils.lerp(this.viewRoll, 0, dt * 14);

    const lateralSpeed = Math.hypot(this.playerBody.velocity.x, this.playerBody.velocity.z);
    const sway = Math.sin(now * 0.011) * Math.min(0.05, lateralSpeed * 0.006);

    this.weaponMount.position.x = 0.28 + sway * 0.65;
    this.weaponMount.position.y =
      -0.22 + Math.abs(sway) * 0.42 - this.viewKickback * 0.32;
    this.weaponMount.position.z =
      -0.5 + Math.abs(sway) * 0.07 + this.viewKickback * 1.15;
    this.weaponMount.rotation.x = -this.viewKickback * 0.72;
    this.weaponMount.rotation.y = 0;
    this.weaponMount.rotation.z = this.viewRoll;

    if (this.muzzleFlashLight) {
      this.muzzleFlashLight.intensity = THREE.MathUtils.lerp(
        this.muzzleFlashLight.intensity,
        0,
        dt * 28,
      );
    }
  }

  private updateRoundTimer(now: number): void {
    const elapsedSeconds = Math.floor((now - this.matchCreatedAt) / 1000);
    const remaining = this.roundSeconds - (elapsedSeconds % this.roundSeconds);

    const minutes = Math.floor(remaining / 60)
      .toString()
      .padStart(2, "0");
    const seconds = Math.floor(remaining % 60)
      .toString()
      .padStart(2, "0");

    this.hud.roundTimer.textContent = `${minutes}:${seconds}`;

    if (remaining !== this.previousRoundSecond && remaining === this.roundSeconds) {
      this.audio.playRoundBell();
    }

    this.previousRoundSecond = remaining;
  }

  private updateShotTracers(dt: number): void {
    for (let index = this.shotTracers.length - 1; index >= 0; index -= 1) {
      const tracer = this.shotTracers[index];
      tracer.ttl -= dt;

      const alpha = clamp(tracer.ttl / tracer.maxTtl, 0, 1);
      tracer.line.material.opacity = alpha * alpha * 0.92;

      if (tracer.ttl > 0) {
        continue;
      }

      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
      this.shotTracers.splice(index, 1);
    }
  }

  private spawnShotTracer(
    origin: THREE.Vector3,
    direction: THREE.Vector3,
    weaponId: WeaponId,
    localShot: boolean,
    hitDistance: number | null = null,
  ): void {
    const normalizedDirection = direction.clone().normalize();
    const wallDistance = findNearestObstacleDistance(
      origin,
      normalizedDirection,
      this.obstacles,
    );

    let travelDistance = 78;

    if (wallDistance !== null && wallDistance > 0.09) {
      travelDistance = Math.min(travelDistance, wallDistance);
    }

    if (hitDistance !== null && Number.isFinite(hitDistance) && hitDistance > 0.09) {
      travelDistance = Math.min(travelDistance, hitDistance);
    }

    travelDistance = clamp(travelDistance, 0.9, 78);

    const start = origin.clone();
    const end = origin.clone().add(normalizedDirection.multiplyScalar(travelDistance));
    const geometry = new THREE.BufferGeometry().setFromPoints([start, end]);

    const color = localShot
      ? weaponId === "shotgun"
        ? "#ffd39e"
        : weaponId === "pistol"
          ? "#8bf7ff"
          : "#7bc8ff"
      : "#ff9d73";

    const material = new THREE.LineBasicMaterial({
      color,
      transparent: true,
      opacity: localShot ? 0.9 : 0.72,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });

    const line = new THREE.Line(geometry, material);
    line.renderOrder = 16;
    this.scene.add(line);

    this.shotTracers.push({
      line,
      ttl: localShot ? 0.08 : 0.1,
      maxTtl: localShot ? 0.08 : 0.1,
    });
  }

  private updateHudValues(): void {
    const activeState = this.weaponStates[this.activeWeapon];
    const spec = WEAPONS[this.activeWeapon];

    this.hud.healthValue.textContent = Math.max(0, Math.round(this.localHealth)).toString();
    this.hud.armorValue.textContent = Math.max(0, Math.round(this.localArmor)).toString();
    this.hud.weaponValue.textContent = spec.label;
    this.hud.ammoValue.textContent = `${activeState.ammoInMag} / ${activeState.ammoReserve}`;
    this.hud.killsValue.textContent = this.localKills.toString();
    this.hud.deathsValue.textContent = this.localDeaths.toString();
  }

  private renderKillFeed(): void {
    const fragment = document.createDocumentFragment();
    const latest = this.killFeed.slice(0, 7);

    for (const kill of latest) {
      const line = document.createElement("div");
      line.className = "feed-line";
      const hs = kill.headshot ? " · HS" : "";
      line.textContent = `${kill.attackerName} → ${kill.victimName} (${kill.weaponId}${hs})`;
      fragment.appendChild(line);
    }

    this.hud.feed.innerHTML = "";
    this.hud.feed.appendChild(fragment);
  }

  private renderScoreboard(): void {
    const counts = new Map<string, number>();

    for (const kill of this.killFeed) {
      counts.set(kill.attackerName, (counts.get(kill.attackerName) ?? 0) + 1);
    }

    const top = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6);

    this.hud.scoreboard.innerHTML = "";

    for (const [name, value] of top) {
      const row = document.createElement("div");
      row.className = "score-row";
      row.innerHTML = `<span>${name}</span><strong>${value}</strong>`;
      this.hud.scoreboard.appendChild(row);
    }

    if (top.length === 0) {
      const empty = document.createElement("div");
      empty.className = "score-row";
      empty.innerHTML = `<span>No eliminations yet</span><strong>0</strong>`;
      this.hud.scoreboard.appendChild(empty);
    }
  }

  private recomputeLocalStats(): void {
    this.localKills = this.killFeed.filter(
      (entry) => entry.attackerPeerId === this.localPeerId,
    ).length;

    this.localDeaths = this.killFeed.filter(
      (entry) => entry.victimPeerId === this.localPeerId,
    ).length;

    if (this.localKills >= this.scoreLimit) {
      this.showToast("Score limit reached. New round is live.");
      this.audio.playRoundBell();
    }
  }

  private tryAutomaticFire(now: number): void {
    if (!this.input.firing || !this.isPointerLocked) {
      return;
    }

    if (!WEAPONS[this.activeWeapon].automatic) {
      return;
    }

    this.tryFire(now);
  }

  private tryFire(now: number): void {
    if (!this.localAlive || !this.room) {
      return;
    }

    const current = this.weaponStates[this.activeWeapon];
    const result = tryFireWeapon(current, now);

    if (!result.didFire) {
      if (result.reason === "empty-mag") {
        this.reloadActiveWeapon();
      }
      return;
    }

    this.weaponStates[this.activeWeapon] = result.next;

    const weaponSpec = WEAPONS[this.activeWeapon];

    const recoilTuning =
      this.activeWeapon === "shotgun"
        ? { view: 0.09 }
        : this.activeWeapon === "pistol"
          ? { view: 0.055 }
          : { view: 0.072 };

    this.viewKickback = Math.min(0.2, this.viewKickback + recoilTuning.view);
    this.viewRoll = clamp(
      this.viewRoll + (Math.random() - 0.5) * (0.035 + recoilTuning.view * 0.22),
      -0.16,
      0.16,
    );

    if (this.muzzleFlashLight) {
      this.muzzleFlashLight.intensity = weaponSpec.muzzleFlashIntensity;
    }

    this.audio.playShot(this.activeWeapon);

    const origin = this.camera.getWorldPosition(new THREE.Vector3());
    const baseDirection = this.camera
      .getWorldDirection(new THREE.Vector3())
      .normalize();

    const damageByPeer = new Map<string, { amount: number; headshot: boolean; name: string }>();

    for (let pellet = 0; pellet < weaponSpec.pellets; pellet += 1) {
      const direction = applySpread(baseDirection, weaponSpec.spread);
      const hit = this.findShotHit(origin, direction);
      this.spawnShotTracer(
        origin,
        direction,
        this.activeWeapon,
        true,
        hit?.distance ?? null,
      );

      if (!hit) {
        continue;
      }

      const damage = computeWeaponDamage(
        this.activeWeapon,
        hit.distance,
        hit.headshot,
      );

      const previous = damageByPeer.get(hit.peerId);

      damageByPeer.set(hit.peerId, {
        amount: (previous?.amount ?? 0) + damage,
        headshot: (previous?.headshot ?? false) || hit.headshot,
        name: hit.playerName,
      });
    }

    if (this.localPeerId) {
      this.room.publishTopic("shot", {
        attackerPeerId: this.localPeerId,
        weaponId: this.activeWeapon,
        originX: origin.x,
        originY: origin.y,
        originZ: origin.z,
        dirX: baseDirection.x,
        dirY: baseDirection.y,
        dirZ: baseDirection.z,
        timestamp: now,
      });
    }

    let landedHit = false;

    for (const [targetPeerId, payload] of damageByPeer) {
      landedHit = true;
      this.room.publishTopic("damage", {
        attackerPeerId: this.localPeerId,
        attackerName: this.localPlayerName,
        targetPeerId,
        damage: payload.amount,
        weaponId: this.activeWeapon,
        headshot: payload.headshot,
        timestamp: now,
      });
    }

    if (landedHit) {
      this.audio.playHit(false);
    }
  }

  private findShotHit(origin: THREE.Vector3, direction: THREE.Vector3): {
    peerId: string;
    playerName: string;
    distance: number;
    headshot: boolean;
  } | null {
    const wallDistance = findNearestObstacleDistance(origin, direction, this.obstacles);

    let closest: {
      peerId: string;
      playerName: string;
      distance: number;
      headshot: boolean;
    } | null = null;

    for (const remote of this.remotePlayers.values()) {
      if (!remote.alive) {
        continue;
      }

      if (!ALLOW_TEAM_DAMAGE && remote.team === this.localTeam) {
        continue;
      }

      const bodyCenter = remote.targetPosition
        .clone()
        .add(new THREE.Vector3(0, 1.04, 0));
      const headCenter = remote.targetPosition
        .clone()
        .add(new THREE.Vector3(0, remote.headY, 0));

      const bodyHit = intersectRaySphere(origin, direction, bodyCenter, 0.62);
      const headHit = intersectRaySphere(origin, direction, headCenter, 0.36);

      const projectedDistance = Math.min(
        headHit ?? Number.POSITIVE_INFINITY,
        bodyHit ?? Number.POSITIVE_INFINITY,
      );

      if (!Number.isFinite(projectedDistance)) {
        continue;
      }

      // Block hits when an arena collider is closer than the target.
      if (
        wallDistance !== null &&
        wallDistance > 0.12 &&
        wallDistance + 0.04 < projectedDistance
      ) {
        continue;
      }

      const headshot = headHit !== null && headHit <= projectedDistance + 0.06;

      if (!closest || projectedDistance < closest.distance) {
        closest = {
          peerId: remote.peerId,
          playerName: remote.playerName,
          distance: projectedDistance,
          headshot,
        };
      }
    }

    return closest;
  }

  private reloadActiveWeapon(): void {
    const now = Date.now();
    const current = this.weaponStates[this.activeWeapon];
    const next = beginReload(current, now);

    if (next === current) {
      return;
    }

    this.weaponStates[this.activeWeapon] = next;
    this.audio.playReload();
  }

  private setActiveWeapon(weaponId: WeaponId): void {
    this.activeWeapon = weaponId;

    if (this.weaponViewModels) {
      for (const id of WEAPON_ORDER) {
        this.weaponViewModels[id].visible = id === weaponId;
      }
    }

    this.persistLoadout();
  }

  private maybePlayFootsteps(now: number): void {
    const horizontalSpeed = Math.hypot(
      this.playerBody.velocity.x,
      this.playerBody.velocity.z,
    );

    if (!this.playerBody.grounded || horizontalSpeed < 1.3) {
      return;
    }

    const cadenceMs = clamp(520 - horizontalSpeed * 28, 220, 520);

    if (now - this.lastFootstepAt < cadenceMs) {
      return;
    }

    this.lastFootstepAt = now;
    this.audio.playFootstep(horizontalSpeed / 9);
  }

  private respawnLocalPlayer(): void {
    this.spawnWave += 1;

    const spawn = this.resolveSpawnPoint(
      pickSpawnPoint(
        this.matchCode,
        this.localPlayerName,
        this.spawnPoints,
        this.spawnWave,
      ),
    );

    this.localHealth = 100;
    this.localArmor = 100;
    this.localAlive = true;
    this.playerBody.position = { ...spawn };
    this.playerBody.velocity = { x: 0, y: 0, z: 0 };
    this.playerBody.crouching = false;
    this.orientSpawnView(spawn);
    this.weaponStates = createInitialWeaponStates();

    this.room?.publishTopic("respawn", {
      peerId: this.localPeerId,
      x: spawn.x,
      y: spawn.y,
      z: spawn.z,
      timestamp: Date.now(),
    });

    this.publishPresence(Date.now());
    this.showToast("Respawned. Re-take the map.");
  }

  private orientSpawnView(spawn: SpawnPoint): void {
    const targetX = 0;
    const targetZ = 0;
    const dx = targetX - spawn.x;
    const dz = targetZ - spawn.z;

    this.playerBody.yaw = Math.atan2(dx, -dz);
    this.playerBody.pitch = -0.03;
  }

  private resolveSpawnPoint(preferred: SpawnPoint): SpawnPoint {
    if (this.isSpawnSafe(preferred)) {
      return preferred;
    }

    for (const spawn of this.spawnPoints) {
      if (this.isSpawnSafe(spawn)) {
        return spawn;
      }
    }

    return preferred;
  }

  private isSpawnSafe(spawn: SpawnPoint): boolean {
    const radius = 0.65;
    const feetY = spawn.y;
    const headY = spawn.y + PLAYER_HEIGHT_STANDING;

    for (const obstacle of this.obstacles) {
      const overlapsVertical = feetY < obstacle.max.y && headY > obstacle.min.y;
      if (!overlapsVertical) {
        continue;
      }

      if (
        spawn.x + radius <= obstacle.min.x ||
        spawn.x - radius >= obstacle.max.x ||
        spawn.z + radius <= obstacle.min.z ||
        spawn.z - radius >= obstacle.max.z
      ) {
        continue;
      }

      return false;
    }

    return true;
  }

  private drawMinimap(): void {
    if (!this.minimapCtx) {
      return;
    }

    const ctx = this.minimapCtx;
    const width = this.hud.minimap.width;
    const height = this.hud.minimap.height;

    ctx.clearRect(0, 0, width, height);

    const bg = ctx.createLinearGradient(0, 0, width, height);
    bg.addColorStop(0, "rgba(7, 13, 22, 0.86)");
    bg.addColorStop(1, "rgba(18, 31, 48, 0.86)");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, width, height);

    ctx.strokeStyle = "rgba(255,255,255,0.16)";
    ctx.lineWidth = 2;
    ctx.strokeRect(2, 2, width - 4, height - 4);

    ctx.strokeStyle = "rgba(124, 156, 191, 0.5)";
    ctx.lineWidth = 1;

    for (const obstacle of this.obstacles) {
      const a = worldToMap(obstacle.min.x, obstacle.min.z, width, height);
      const b = worldToMap(obstacle.max.x, obstacle.max.z, width, height);

      ctx.strokeRect(
        Math.min(a.x, b.x),
        Math.min(a.y, b.y),
        Math.abs(b.x - a.x),
        Math.abs(b.y - a.y),
      );
    }

    const me = worldToMap(this.playerBody.position.x, this.playerBody.position.z, width, height);
    ctx.fillStyle = "#8ff9ff";
    ctx.beginPath();
    ctx.arc(me.x, me.y, 5, 0, Math.PI * 2);
    ctx.fill();

    const facing = {
      x: me.x + Math.sin(this.playerBody.yaw) * 12,
      y: me.y - Math.cos(this.playerBody.yaw) * 12,
    };

    ctx.strokeStyle = "#8ff9ff";
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(me.x, me.y);
    ctx.lineTo(facing.x, facing.y);
    ctx.stroke();

    for (const remote of this.remotePlayers.values()) {
      const marker = worldToMap(remote.group.position.x, remote.group.position.z, width, height);

      ctx.fillStyle = remote.team === this.localTeam ? "#32a7ff" : "#ff7842";
      ctx.beginPath();
      ctx.arc(marker.x, marker.y, 4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  private setStatus(message: string): void {
    this.hud.statusText.textContent = message;
  }

  private showToast(message: string): void {
    this.hud.toast.textContent = message;
    this.hud.toast.classList.add("visible");

    window.setTimeout(() => {
      this.hud.toast.classList.remove("visible");
    }, 2200);
  }

  private cleanupRoomSubscriptions(): void {
    this.unsubscribePresence?.();
    this.unsubscribeShots?.();
    this.unsubscribeDamage?.();
    this.unsubscribeRespawn?.();

    this.unsubscribePresence = null;
    this.unsubscribeShots = null;
    this.unsubscribeDamage = null;
    this.unsubscribeRespawn = null;

    this.room?.leaveRoom();
    this.room = null;
  }

  destroy(): void {
    window.cancelAnimationFrame(this.frameHandle);
    this.cleanupRoomSubscriptions();
    this.clearShotTracers();

    for (const remote of this.remotePlayers.values()) {
      remote.mixer?.stopAllAction();
      remote.mixer?.uncacheRoot(remote.group);
      this.scene.remove(remote.group);
    }
    this.remotePlayers.clear();

    this.unsubscribeKills?.();
    this.unsubscribeConnection?.();

    this.unsubscribeKills = null;
    this.unsubscribeConnection = null;

    this.renderer.dispose();
  }

  private clearShotTracers(): void {
    for (const tracer of this.shotTracers) {
      this.scene.remove(tracer.line);
      tracer.line.geometry.dispose();
      tracer.line.material.dispose();
    }
    this.shotTracers = [];
  }
}

function pickRemoteClips(clips: THREE.AnimationClip[]): {
  idleClip: THREE.AnimationClip | null;
  moveClip: THREE.AnimationClip | null;
} {
  const normalized = clips.map((clip) => ({
    clip,
    key: clip.name.toLowerCase(),
  }));

  const idle =
    normalized.find(({ key }) => key.includes("idle"))?.clip ??
    normalized.find(({ key }) => key.includes("tpose"))?.clip ??
    clips[0] ??
    null;

  const move =
    normalized.find(({ key }) => key.includes("run"))?.clip ??
    normalized.find(({ key }) => key.includes("walk"))?.clip ??
    normalized.find(({ key }) => key.includes("move"))?.clip ??
    clips[0] ??
    null;

  return {
    idleClip: idle,
    moveClip: move,
  };
}

function findWeaponSocket(root: THREE.Object3D): THREE.Object3D {
  const byPriority = [
    "mixamorigrighthand",
    "mixamorig:righthand",
    "skeleton_arm_joint_r__3_",
    "skeleton_arm_joint_r",
    "righthand",
    "hand_r",
    "arm_joint_r__3_",
    "arm_joint_r",
  ];

  const nodes: THREE.Object3D[] = [];
  root.traverse((node) => {
    nodes.push(node);
  });

  for (const key of byPriority) {
    const found = nodes.find((node) => node.name.toLowerCase() === key);
    if (found) {
      return found;
    }
  }

  for (const key of byPriority) {
    const found = nodes.find((node) => node.name.toLowerCase().includes(key));
    if (found) {
      return found;
    }
  }

  const fuzzy = nodes.find((node) => {
    const key = node.name.toLowerCase();
    return (
      (key.includes("right") || key.includes("_r") || key.includes(":r")) &&
      key.includes("hand")
    );
  });
  if (fuzzy) {
    return fuzzy;
  }

  const fallback = nodes.find((node) => {
    const key = node.name.toLowerCase();
    return (
      (key.includes("right") || key.includes("_r") || key.includes(":r")) &&
      key.includes("arm")
    );
  });

  return fallback ?? root;
}

function orientWeaponToCharacterForward(
  weapon: THREE.Object3D,
  socket: THREE.Object3D,
  characterRoot: THREE.Object3D,
): void {
  characterRoot.updateWorldMatrix(true, true);

  const socketWorldQuat = new THREE.Quaternion();
  socket.getWorldQuaternion(socketWorldQuat);
  const inverseSocketQuat = socketWorldQuat.clone().invert();

  const rootWorldQuat = new THREE.Quaternion();
  characterRoot.getWorldQuaternion(rootWorldQuat);

  const forwardWorld = new THREE.Vector3(0, 0, -1).applyQuaternion(rootWorldQuat);
  const upWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(rootWorldQuat);

  const xAxis = forwardWorld.applyQuaternion(inverseSocketQuat).normalize();
  const upAxis = upWorld.applyQuaternion(inverseSocketQuat).normalize();

  if (xAxis.lengthSq() <= 1e-8 || upAxis.lengthSq() <= 1e-8) {
    return;
  }

  let zAxis = new THREE.Vector3().crossVectors(xAxis, upAxis);
  if (zAxis.lengthSq() <= 1e-8) {
    zAxis.set(0, 0, 1);
  } else {
    zAxis.normalize();
  }

  const yAxis = new THREE.Vector3().crossVectors(zAxis, xAxis).normalize();
  if (yAxis.lengthSq() <= 1e-8) {
    return;
  }

  const basis = new THREE.Matrix4().makeBasis(xAxis, yAxis, zAxis);
  weapon.quaternion.setFromRotationMatrix(basis);
}

function fitObjectWorldLongestEdge(object: THREE.Object3D, targetLongest: number): void {
  object.updateWorldMatrix(true, true);
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) {
    return;
  }

  const size = new THREE.Vector3();
  bounds.getSize(size);
  const longest = Math.max(size.x, size.y, size.z);

  if (longest <= 0) {
    return;
  }

  object.scale.multiplyScalar(targetLongest / longest);
}

function intersectRaySphere(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  center: THREE.Vector3,
  radius: number,
): number | null {
  const toCenter = center.clone().sub(origin);
  const projected = toCenter.dot(direction);
  if (projected <= 0) {
    return null;
  }

  const closestPoint = origin.clone().add(direction.clone().multiplyScalar(projected));
  const distSq = closestPoint.distanceToSquared(center);
  const radiusSq = radius * radius;
  if (distSq > radiusSq) {
    return null;
  }

  const penetration = Math.sqrt(radiusSq - distSq);
  const t = projected - penetration;
  return t > 0 ? t : projected;
}

function findNearestObstacleDistance(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  obstacles: Aabb[],
): number | null {
  let nearest = Number.POSITIVE_INFINITY;

  for (const obstacle of obstacles) {
    const hitDistance = intersectRayAabb(origin, direction, obstacle);
    if (hitDistance === null) {
      continue;
    }

    if (hitDistance < nearest) {
      nearest = hitDistance;
    }
  }

  return Number.isFinite(nearest) ? nearest : null;
}

function intersectRayAabb(
  origin: THREE.Vector3,
  direction: THREE.Vector3,
  obstacle: Aabb,
): number | null {
  const epsilon = 1e-6;
  let tMin = -Infinity;
  let tMax = Infinity;

  const axis: Array<"x" | "y" | "z"> = ["x", "y", "z"];
  for (const key of axis) {
    const dir = direction[key];
    const originValue = origin[key];
    const min = obstacle.min[key];
    const max = obstacle.max[key];

    if (Math.abs(dir) < epsilon) {
      if (originValue < min || originValue > max) {
        return null;
      }
      continue;
    }

    let t1 = (min - originValue) / dir;
    let t2 = (max - originValue) / dir;
    if (t1 > t2) {
      const swap = t1;
      t1 = t2;
      t2 = swap;
    }

    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMax < tMin) {
      return null;
    }
  }

  if (tMax < 0) {
    return null;
  }

  if (tMin >= 0) {
    return tMin;
  }

  return tMax >= 0 ? tMax : null;
}

function worldToMap(
  x: number,
  z: number,
  width: number,
  height: number,
): { x: number; y: number } {
  const normalizedX = (x + WORLD_HALF_SIZE) / (WORLD_HALF_SIZE * 2);
  const normalizedY = (z + WORLD_HALF_SIZE) / (WORLD_HALF_SIZE * 2);

  return {
    x: clamp(normalizedX, 0, 1) * width,
    y: clamp(normalizedY, 0, 1) * height,
  };
}

function tintCharacter(root: THREE.Object3D, team: TeamName): void {
  const tint = new THREE.Color(team === "counter" ? "#6acbff" : "#ff8757");

  root.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    if (Array.isArray(mesh.material)) {
      for (const material of mesh.material) {
        const maybe = material as THREE.MeshStandardMaterial;
        if ("emissive" in maybe) {
          maybe.emissive = tint.clone().multiplyScalar(0.12);
        }
      }
    } else {
      const material = mesh.material as THREE.MeshStandardMaterial;
      if ("emissive" in material) {
        material.emissive = tint.clone().multiplyScalar(0.12);
      }
    }
  });
}

function buildSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 1024;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  const gradient = context.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "#3d6b99");
  gradient.addColorStop(0.52, "#1d3857");
  gradient.addColorStop(1, "#0a1322");

  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 160; index += 1) {
    const x = Math.random() * canvas.width;
    const y = Math.random() * canvas.height * 0.62;
    const radius = 35 + Math.random() * 120;
    const alpha = 0.016 + Math.random() * 0.03;

    const cloud = context.createRadialGradient(x, y, 0, x, y, radius);
    cloud.addColorStop(0, `rgba(188, 220, 248, ${alpha.toFixed(3)})`);
    cloud.addColorStop(1, "rgba(188, 220, 248, 0)");
    context.fillStyle = cloud;
    context.beginPath();
    context.arc(x, y, radius, 0, Math.PI * 2);
    context.fill();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildTacticalFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  context.fillStyle = "#3f556f";
  context.fillRect(0, 0, canvas.width, canvas.height);

  const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
  gradient.addColorStop(0, "rgba(255,255,255,0.15)");
  gradient.addColorStop(0.45, "rgba(255,255,255,0)");
  gradient.addColorStop(1, "rgba(0,0,0,0.18)");
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 1200; index += 1) {
    const size = Math.random() * 3 + 0.8;
    context.fillStyle = `rgba(255,255,255,${Math.random() * 0.08})`;
    context.fillRect(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      size,
      size,
    );
  }

  for (let crack = 0; crack < 30; crack += 1) {
    const startX = Math.random() * canvas.width;
    const startY = Math.random() * canvas.height;
    context.strokeStyle =
      crack % 2 === 0 ? "rgba(14, 22, 34, 0.34)" : "rgba(198, 223, 251, 0.08)";
    context.lineWidth = 0.8 + Math.random() * 1.2;
    context.beginPath();
    context.moveTo(startX, startY);

    let x = startX;
    let y = startY;
    for (let segment = 0; segment < 7; segment += 1) {
      x += (Math.random() - 0.5) * 42;
      y += (Math.random() - 0.5) * 42;
      context.lineTo(x, y);
    }

    context.stroke();
  }

  context.strokeStyle = "rgba(236, 248, 255, 0.28)";
  context.lineWidth = 9;
  context.beginPath();
  context.moveTo(52, canvas.height / 2 + 20);
  context.lineTo(canvas.width - 52, canvas.height / 2 + 20);
  context.stroke();

  context.strokeStyle = "rgba(255, 177, 122, 0.46)";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(52, canvas.height / 2 - 20);
  context.lineTo(canvas.width - 52, canvas.height / 2 - 20);
  context.stroke();

  for (let index = 0; index < 5200; index += 1) {
    const noise = Math.random() * 9;
    context.fillStyle = `rgba(255,255,255,${Math.random() * 0.04})`;
    context.fillRect(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      noise,
      1,
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function prepareArenaTexture(
  texture: THREE.Texture,
  repeatX: number,
  repeatY: number,
  anisotropy: number,
): void {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(repeatX, repeatY);
  texture.anisotropy = anisotropy;
  texture.colorSpace = THREE.SRGBColorSpace;
}

function buildConcreteTexture(
  base: string,
  shadow: string,
  highlight: string,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  context.fillStyle = base;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let index = 0; index < 1600; index += 1) {
    const size = Math.random() * 18 + 4;
    context.fillStyle = `rgba(255,255,255,${Math.random() * 0.06})`;
    context.fillRect(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      size,
      Math.random() * 2 + 0.8,
    );
  }

  for (let crack = 0; crack < 26; crack += 1) {
    const startX = Math.random() * canvas.width;
    const startY = Math.random() * canvas.height;
    context.strokeStyle = crack % 2 === 0 ? `${shadow}aa` : `${highlight}66`;
    context.lineWidth = 0.8 + Math.random() * 1.2;
    context.beginPath();
    context.moveTo(startX, startY);

    let x = startX;
    let y = startY;
    for (let segment = 0; segment < 6; segment += 1) {
      x += (Math.random() - 0.5) * 56;
      y += (Math.random() - 0.5) * 56;
      context.lineTo(x, y);
    }

    context.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildPanelTexture(
  base: string,
  seam: string,
  highlight: string,
): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  context.fillStyle = base;
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y += 64) {
    context.strokeStyle = `${seam}cc`;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(canvas.width, y);
    context.stroke();
  }

  for (let x = 0; x < canvas.width; x += 64) {
    context.strokeStyle = `${seam}aa`;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(x, 0);
    context.lineTo(x, canvas.height);
    context.stroke();
  }

  for (let index = 0; index < 2600; index += 1) {
    context.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    context.fillRect(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      1 + Math.random() * 3,
      1 + Math.random() * 3,
    );
  }

  context.strokeStyle = `${highlight}aa`;
  context.lineWidth = 3;
  context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function buildCrateTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 512;

  const context = canvas.getContext("2d");
  if (!context) {
    return new THREE.CanvasTexture(canvas);
  }

  context.fillStyle = "#6c5138";
  context.fillRect(0, 0, canvas.width, canvas.height);

  for (let y = 0; y < canvas.height; y += 42) {
    context.fillStyle = y % 84 === 0 ? "rgba(255, 210, 160, 0.17)" : "rgba(0,0,0,0.09)";
    context.fillRect(0, y, canvas.width, 20);
  }

  for (let x = 0; x < canvas.width; x += 72) {
    context.fillStyle = "rgba(28, 18, 11, 0.21)";
    context.fillRect(x, 0, 8, canvas.height);
  }

  for (let index = 0; index < 2800; index += 1) {
    context.fillStyle = `rgba(255,255,255,${Math.random() * 0.05})`;
    context.fillRect(
      Math.random() * canvas.width,
      Math.random() * canvas.height,
      2 + Math.random() * 8,
      0.7 + Math.random() * 1.4,
    );
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function lerpAngle(current: number, target: number, alpha: number): number {
  const delta = Math.atan2(Math.sin(target - current), Math.cos(target - current));
  return current + delta * alpha;
}

function applySpread(direction: THREE.Vector3, spread: number): THREE.Vector3 {
  return new THREE.Vector3(
    direction.x + (Math.random() - 0.5) * spread,
    direction.y + (Math.random() - 0.5) * spread,
    direction.z + (Math.random() - 0.5) * spread,
  ).normalize();
}

function configureWorldWeaponAttachment(
  weapon: THREE.Group,
  attachToHand = false,
): void {
  if (attachToHand) {
    weapon.position.set(0, 0, 0);
    weapon.rotation.set(0, 0, 0);
  } else {
    fitObjectLongestEdge(weapon, 0.72);
    weapon.position.set(0.22, 1.1, 0.14);
    weapon.rotation.set(0.06, Math.PI, -0.06);
  }

  weapon.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    mesh.castShadow = true;
    mesh.receiveShadow = false;
  });
}

function configureViewModel(model: THREE.Group): void {
  model.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.frustumCulled = false;

    if (Array.isArray(mesh.material)) {
      mesh.material = mesh.material.map((material) =>
        createReadableViewMaterial(material),
      );
      return;
    }

    mesh.material = createReadableViewMaterial(mesh.material);
  });
}

function createReadableViewMaterial(material: THREE.Material): THREE.Material {
  const cloned = material.clone();
  cloned.depthTest = false;
  cloned.depthWrite = false;
  (cloned as THREE.Material & { fog?: boolean }).fog = false;

  if (
    cloned instanceof THREE.MeshStandardMaterial ||
    cloned instanceof THREE.MeshPhysicalMaterial
  ) {
    cloned.metalness = Math.min(cloned.metalness, 0.32);
    cloned.roughness = Math.max(cloned.roughness, 0.46);
    if (cloned.name.toLowerCase().includes("black")) {
      cloned.color.set("#2f3d4f");
    } else {
      cloned.color.multiplyScalar(1.2);
    }
    cloned.emissive = cloned.color.clone().multiplyScalar(0.06);
    cloned.emissiveIntensity = 1;
  }

  return cloned;
}

function fitObjectLongestEdge(object: THREE.Object3D, targetLongest: number): void {
  const bounds = new THREE.Box3().setFromObject(object);
  if (bounds.isEmpty()) {
    return;
  }

  const size = new THREE.Vector3();
  bounds.getSize(size);

  const longest = Math.max(size.x, size.y, size.z);
  if (longest <= 0) {
    return;
  }

  const scalar = targetLongest / longest;
  object.scale.multiplyScalar(scalar);

  const normalizedBounds = new THREE.Box3().setFromObject(object);
  const center = new THREE.Vector3();
  normalizedBounds.getCenter(center);
  object.position.sub(center);
}

function isWeaponId(value: string | undefined): value is WeaponId {
  return value === "assaultRifle" || value === "shotgun" || value === "pistol";
}

function isCharacterId(value: string | undefined): value is CharacterId {
  return value === "soldier" || value === "cesium";
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
