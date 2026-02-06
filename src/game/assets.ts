import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/examples/jsm/loaders/DRACOLoader.js";
import { clone as cloneSkeleton } from "three/examples/jsm/utils/SkeletonUtils.js";
import type { CharacterId, WeaponId } from "./types";
import { WEAPONS } from "./weapons";

const loader = new GLTFLoader();
const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("/assets/draco/gltf/");
loader.setDRACOLoader(dracoLoader);

const ARENA_MODEL_PATH = "/assets/models/maps/virtual-city.glb";

const CHARACTER_MODEL_PATHS: Record<CharacterId, string> = {
  soldier: "/assets/models/characters/soldier.glb",
  cesium: "/assets/models/characters/cesium-man.glb",
};

const CHARACTER_SCALES: Record<CharacterId, number> = {
  soldier: 1,
  cesium: 1.04,
};

export interface GameAssets {
  weaponTemplates: Record<WeaponId, THREE.Group>;
  characterTemplates: Record<CharacterId, CharacterTemplate>;
  arenaTemplate: THREE.Group;
}

export interface CharacterTemplate {
  model: THREE.Group;
  clips: THREE.AnimationClip[];
}

export async function loadGameAssets(): Promise<GameAssets> {
  const [characterTemplates, weaponTemplates, arenaTemplate] = await Promise.all([
    loadCharacters(),
    loadWeapons(),
    loadArena(),
  ]);

  return {
    characterTemplates,
    weaponTemplates,
    arenaTemplate,
  };
}

async function loadCharacters(): Promise<Record<CharacterId, CharacterTemplate>> {
  const entries = await Promise.all(
    (Object.keys(CHARACTER_MODEL_PATHS) as CharacterId[]).map(async (id) => {
      const gltf = await loader.loadAsync(CHARACTER_MODEL_PATHS[id]);
      const root = gltf.scene;
      root.scale.setScalar(CHARACTER_SCALES[id]);
      configureRenderable(root);

      return [id, { model: root, clips: gltf.animations }] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<CharacterId, CharacterTemplate>;
}

async function loadWeapons(): Promise<Record<WeaponId, THREE.Group>> {
  const entries = await Promise.all(
    (Object.keys(WEAPONS) as WeaponId[]).map(async (id) => {
      const gltf = await loader.loadAsync(WEAPONS[id].modelPath);
      const root = gltf.scene;
      root.scale.setScalar(1);
      configureRenderable(root);

      return [id, root] as const;
    }),
  );

  return Object.fromEntries(entries) as Record<WeaponId, THREE.Group>;
}

async function loadArena(): Promise<THREE.Group> {
  const gltf = await loader.loadAsync(ARENA_MODEL_PATH);
  const root = gltf.scene;
  configureRenderable(root);
  pruneOversizedBackdropShells(root);
  normalizeArena(root);
  return root;
}

function configureRenderable(object: THREE.Object3D): void {
  object.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;

    if (!mesh.isMesh) {
      return;
    }

    mesh.castShadow = true;
    mesh.receiveShadow = false;

    if (Array.isArray(mesh.material)) {
      mesh.material.forEach((material: THREE.Material) => {
        tuneReadableMaterial(material);
        material.side = THREE.FrontSide;
      });
    } else {
      tuneReadableMaterial(mesh.material);
      mesh.material.side = THREE.FrontSide;
    }
  });
}

function tuneReadableMaterial(material: THREE.Material): void {
  if (
    material instanceof THREE.MeshStandardMaterial ||
    material instanceof THREE.MeshPhysicalMaterial
  ) {
    material.metalness = Math.min(material.metalness, 0.26);
    material.roughness = Math.max(material.roughness, 0.5);
    material.envMapIntensity = Math.max(material.envMapIntensity, 1.35);
    material.color.multiplyScalar(1.22);

    const color = material.color;
    const luminance = color.r * 0.2126 + color.g * 0.7152 + color.b * 0.0722;
    if (luminance < 0.22 || material.name.toLowerCase().includes("black")) {
      color.lerp(new THREE.Color("#6d87a4"), 0.58);
    }

    material.emissive = color.clone().multiplyScalar(0.018);
    material.emissiveIntensity = 0.65;
  }
}

function normalizeArena(root: THREE.Group): void {
  const initialBounds = new THREE.Box3().setFromObject(root);
  if (initialBounds.isEmpty()) {
    return;
  }

  const initialSize = new THREE.Vector3();
  initialBounds.getSize(initialSize);
  const longestXZ = Math.max(initialSize.x, initialSize.z);

  if (longestXZ > 0) {
    root.scale.setScalar(72 / longestXZ);
  }

  const centeredBounds = new THREE.Box3().setFromObject(root);
  const center = new THREE.Vector3();
  centeredBounds.getCenter(center);
  root.position.sub(center);

  const floorBounds = new THREE.Box3().setFromObject(root);
  root.position.y -= floorBounds.min.y;
  root.position.y -= 0.02;
}

function pruneOversizedBackdropShells(root: THREE.Group): void {
  const toRemove: THREE.Object3D[] = [];

  root.traverse((child: THREE.Object3D) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh) {
      return;
    }

    const geometry = mesh.geometry;
    if (!geometry.boundingBox) {
      geometry.computeBoundingBox();
    }
    if (!geometry.boundingSphere) {
      geometry.computeBoundingSphere();
    }

    const bounds = geometry.boundingBox;
    const radius = geometry.boundingSphere?.radius ?? 0;
    if (!bounds) {
      return;
    }

    const size = new THREE.Vector3();
    bounds.getSize(size);

    const triCount = geometry.index
      ? geometry.index.count / 3
      : geometry.attributes.position.count / 3;

    const name = mesh.name.toLowerCase();
    const materialNames = Array.isArray(mesh.material)
      ? mesh.material.map((material) => material.name.toLowerCase()).join(" ")
      : mesh.material.name.toLowerCase();

    const oneThinAxis =
      (size.x < 45 && size.y > 1500 && size.z > 1500) ||
      (size.y < 45 && size.x > 1500 && size.z > 1500) ||
      (size.z < 45 && size.x > 1500 && size.y > 1500);

    const likelyEnvelopeByName =
      name.includes("rectangle") ||
      name.includes("heli-body") ||
      name.includes("sky") ||
      materialNames.includes("__-_default");

    const hugeAndSparse =
      radius > 900 &&
      (triCount < 700 || oneThinAxis || Math.max(size.x, size.y, size.z) > 3500);

    if (likelyEnvelopeByName && hugeAndSparse) {
      toRemove.push(mesh);
      return;
    }

    if (radius > 700 && triCount <= 20) {
      toRemove.push(mesh);
      return;
    }

    if (oneThinAxis && triCount < 120) {
      toRemove.push(mesh);
    }
  });

  for (const node of toRemove) {
    node.parent?.remove(node);
  }
}

export function cloneCharacterTemplate(template: CharacterTemplate): THREE.Group {
  return cloneSkeleton(template.model) as THREE.Group;
}

export function cloneWeaponTemplate(template: THREE.Group): THREE.Group {
  return template.clone(true);
}

export function createNameTagSprite(name: string, team: string): THREE.Sprite {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 128;

  const context = canvas.getContext("2d");
  if (!context) {
    const texture = new THREE.Texture();
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture }));
    return sprite;
  }

  const gradient = context.createLinearGradient(0, 0, canvas.width, 0);
  gradient.addColorStop(0, team === "counter" ? "#1cb3ff" : "#ff7b2c");
  gradient.addColorStop(1, "#ffffff");

  context.fillStyle = "rgba(5, 8, 18, 0.7)";
  context.fillRect(0, 0, canvas.width, canvas.height);

  context.strokeStyle = "rgba(255,255,255,0.18)";
  context.lineWidth = 4;
  context.strokeRect(4, 4, canvas.width - 8, canvas.height - 8);

  context.fillStyle = gradient;
  context.font = "600 50px Rajdhani, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(name.slice(0, 16), canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;

  const sprite = new THREE.Sprite(
    new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthWrite: false,
      depthTest: false,
    }),
  );

  sprite.scale.set(1.9, 0.45, 1);
  sprite.position.set(0, 2.2, 0);

  return sprite;
}
