import { useEffect, useMemo, useRef } from "react";

import ForceGraph3D, { type ForceGraph3DInstance } from "3d-force-graph";
import * as THREE from "three";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";

import type { MemoryGraph } from "../lib/memory";

// resolved hex (three.js can't read css vars).
const TYPE_HEX: Record<string, string> = {
  user: "#f26522",
  feedback: "#facc15",
  project: "#60a5fa",
  reference: "#4ade80",
};
const typeHex = (t: string) => TYPE_HEX[t] ?? "#7a7a82";

interface GNode {
  id: string;
  title: string;
  type: string;
  description: string;
  path: string;
  degree: number;
  x?: number;
  y?: number;
  z?: number;
}

interface GLink {
  source: string;
  target: string;
}

export function Graph3D({
  graph,
  degree,
  selected,
  onSelect,
}: {
  graph: MemoryGraph;
  degree: Map<string, number>;
  selected: string | null;
  onSelect: (id: string) => void;
}) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const fgRef = useRef<ForceGraph3DInstance | null>(null);
  const nodeObjRef = useRef<Map<string, THREE.Mesh>>(new Map());
  const selRef = useRef<string | null>(selected);
  const onSelectRef = useRef(onSelect);
  const lastInteractRef = useRef<number>(0);
  const framedRef = useRef(false);

  useEffect(() => {
    onSelectRef.current = onSelect;
  }, [onSelect]);

  const data = useMemo(() => {
    const nodes: GNode[] = graph.nodes.map((n) => ({
      id: n.id,
      title: n.title,
      type: n.type,
      description: n.description,
      path: n.path,
      degree: degree.get(n.id) ?? 0,
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const links: GLink[] = graph.edges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => ({ source: e.source, target: e.target }));
    return { nodes, links };
  }, [graph, degree]);

  const radiusOf = (d: number) => 4 + Math.min(9, d * 1.4);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;

    const fg: ForceGraph3DInstance = new ForceGraph3D(wrap, {
      controlType: "orbit",
      rendererConfig: { antialias: true, alpha: true },
    });
    fgRef.current = fg;

    const applySize = () => {
      const w = wrap.clientWidth || wrap.getBoundingClientRect().width;
      const h = wrap.clientHeight || wrap.getBoundingClientRect().height;
      if (w > 0 && h > 0) {
        fg.width(w).height(h);
        return true;
      }
      return false;
    };

    fg.backgroundColor("rgba(0,0,0,0)")
      .showNavInfo(false)
      .nodeLabel((n) => `<div style="font:12px ui-sans-serif,system-ui;color:#f3f3f5;
        background:rgba(10,16,24,0.9);border:1px solid rgba(255,255,255,0.12);
        padding:3px 7px;border-radius:5px;white-space:nowrap">${escapeHtml((n as GNode).title)}</div>`)
      .nodeRelSize(6)
      .nodeColor((n) => typeHex((n as GNode).type))
      .nodeOpacity(1)
      .nodeThreeObject((n) => buildNodeObject(n as GNode, nodeObjRef.current, radiusOf))
      .nodeThreeObjectExtend(false)
      .linkColor(() => "rgba(190,200,220,0.28)")
      .linkWidth(0.7)
      .linkOpacity(0.6)
      .linkDirectionalParticles(2)
      .linkDirectionalParticleWidth(1.6)
      .linkDirectionalParticleSpeed(0.006)
      .linkDirectionalParticleColor(() => "#f26522")
      .warmupTicks(40)
      .cooldownTicks(120)
      .d3VelocityDecay(0.3)
      .onNodeClick((n) => {
        const gn = n as GNode;
        onSelectRef.current(gn.id);
        flyTo(fg, gn);
      })
      .onBackgroundClick(() => onSelectRef.current(""))
      .onEngineStop(() => {
        if (!framedRef.current) {
          framedRef.current = true;
          if (applySize()) fg.zoomToFit(700, 60);
        }
      });

    const charge = fg.d3Force("charge") as { strength?: (n: number) => unknown } | undefined;
    charge?.strength?.(-160);
    const linkF = fg.d3Force("link") as { distance?: (n: number) => unknown } | undefined;
    linkF?.distance?.(55);

    fg.scene().add(new THREE.AmbientLight(0xffffff, 0.7));
    const key = new THREE.PointLight(0xffd9b3, 1.1, 0, 0);
    key.position.set(200, 200, 200);
    fg.scene().add(key);
    const fill = new THREE.PointLight(0x6ea8ff, 0.6, 0, 0);
    fill.position.set(-200, -120, -160);
    fg.scene().add(fill);

    try {
      const composer = fg.postProcessingComposer();
      const w = wrap.clientWidth || 1;
      const h = wrap.clientHeight || 1;
      const bloom = new UnrealBloomPass(new THREE.Vector2(w, h), 0.7, 0.5, 0.2);
      composer.addPass(bloom);
    } catch {
      // postprocessing not available; emissive materials still glow softly.
    }

    let sizeRaf = 0;
    const ensureSized = (tries = 0) => {
      if (applySize() || tries > 20) return;
      sizeRaf = requestAnimationFrame(() => ensureSized(tries + 1));
    };
    ensureSized();
    const ro = new ResizeObserver(() => {
      applySize();
    });
    ro.observe(wrap);

    const markActive = () => {
      lastInteractRef.current = Date.now();
    };
    wrap.addEventListener("pointerdown", markActive);
    wrap.addEventListener("wheel", markActive, { passive: true });
    lastInteractRef.current = Date.now();
    let angle = Math.PI * 0.25;
    let raf = 0;
    const spin = () => {
      raf = requestAnimationFrame(spin);
      if (!framedRef.current || selRef.current || Date.now() - lastInteractRef.current < 2500) {
        return;
      }
      angle += 0.0015;
      const cam = fg.camera() as THREE.PerspectiveCamera;
      const dist = Math.hypot(cam.position.x, cam.position.z) || 300;
      fg.cameraPosition({
        x: dist * Math.sin(angle),
        y: cam.position.y,
        z: dist * Math.cos(angle),
      });
    };
    raf = requestAnimationFrame(spin);

    return () => {
      if (sizeRaf) cancelAnimationFrame(sizeRaf);
      if (raf) cancelAnimationFrame(raf);
      ro.disconnect();
      wrap.removeEventListener("pointerdown", markActive);
      wrap.removeEventListener("wheel", markActive);
      try {
        fg._destructor();
      } catch {
        // noop
      }
      nodeObjRef.current.clear();
      fgRef.current = null;
    };
    // instantiate once; data + selection handled by dedicated effects.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const fg = fgRef.current;
    if (!fg) return;
    nodeObjRef.current.clear();
    framedRef.current = false;
    fg.graphData(data);
    const t = setTimeout(() => {
      if (!framedRef.current) {
        const w = wrapRef.current?.clientWidth ?? 0;
        const h = wrapRef.current?.clientHeight ?? 0;
        if (w > 0 && h > 0) {
          framedRef.current = true;
          fg.zoomToFit(700, 60);
        }
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [data]);

  useEffect(() => {
    selRef.current = selected;
    const fg = fgRef.current;
    if (!fg) return;
    nodeObjRef.current.forEach((mesh, id) => {
      const mat = mesh.material as THREE.MeshStandardMaterial;
      const isSel = id === selected;
      const anySel = !!selected;
      mat.emissiveIntensity = isSel ? 2.4 : anySel ? 0.55 : 1.15;
      mat.opacity = anySel && !isSel ? 0.45 : 1;
      mesh.scale.setScalar(isSel ? 1.55 : 1);
    });
    if (selected) {
      const node = (fg.graphData().nodes as GNode[]).find((n) => n.id === selected);
      if (node) flyTo(fg, node);
    }
  }, [selected]);

  return <div ref={wrapRef} className="absolute inset-0 h-full w-full" />;
}

function buildNodeObject(
  n: GNode,
  store: Map<string, THREE.Mesh>,
  radiusOf: (d: number) => number,
): THREE.Object3D {
  const r = radiusOf(n.degree);
  const color = new THREE.Color(typeHex(n.type));
  const geo = new THREE.SphereGeometry(r, 24, 24);
  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive: color,
    emissiveIntensity: 1.15,
    roughness: 0.4,
    metalness: 0.05,
    transparent: true,
    opacity: 1,
  });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = `mem-node:${n.id}`;
  store.set(n.id, mesh);
  return mesh;
}

function flyTo(fg: ForceGraph3DInstance, n: GNode) {
  const x = n.x ?? 0;
  const y = n.y ?? 0;
  const z = n.z ?? 0;
  const dist = 90;
  const len = Math.hypot(x, y, z) || 1;
  const ratio = 1 + dist / len;
  fg.cameraPosition({ x: x * ratio, y: y * ratio, z: z * ratio }, { x, y, z }, 900);
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}
